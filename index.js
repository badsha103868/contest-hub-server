const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;

// firebase admin key
const admin = require("firebase-admin");

// const serviceAccount = require("./contest-hub-firebase-adminsdk.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);

const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// stripe connection string
const stripe = require("stripe")(process.env.STRIPE_SECRET);

// middleware
app.use(express.json());
app.use(cors());

//  jwt verify middleware
const verifyFBToken = async (req, res, next) => {
  console.log("headers in the middleware", req.headers.authorization);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    // console.log(idToken)
    const decoded = await admin.auth().verifyIdToken(idToken);

    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    //  jodi error khai
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// mongodb connection string
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@portfolio-cluster1.ea8n2bl.mongodb.net/?appName=portfolio-cluster1`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("contestHubDB");
    const contestsCollection = db.collection("contests");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("users");

    //  users related apis

    //    GET
    app.get("/users", async (req, res) => {
      // console.log(req.headers)
      const cursor = usersCollection.find().sort({ createdAt: -1 }).limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });

    //   POST
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const existsUser = await usersCollection.findOne({ email });
      if (existsUser) {
        return res.send({ message: "user exists" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // user ar role onujayi get
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // PATCH
    app.patch("/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const query = { _id: new ObjectId(id) };

      const updatedUser = { $set: { role } };
      const result = await usersCollection.updateOne(query, updatedUser);
      res.send(result);
    });

    //  contests related apis
    //  Get all contest
    // app.get('/contest', async(req, res)=>{
    //   const cursor = contestsCollection.find()
    //   const result = await cursor.toArray()
    //   res.send(result)
    // })

    //    GET user ar my  Contests
    app.get("/contests", async (req, res) => {
      const query = {};
      const { email, type, status, sort } = req.query;

      // creator contests
      if (email) {
        query.creator_email = email;
      }
      // contest status (approved / pending / rejected)
      if (status) {
        query.status = status;
      }
      // search by contest type
      if (type) {
        query.contest_type = { $regex: type, $options: "i" };
      }

      let cursor = contestsCollection.find(query);

      if (sort) {
        cursor = cursor.sort({ participants: -1 }).limit(6);
      }
      const result = await cursor.toArray();
      res.send(result);
    });

    // GET distinct contest types
    app.get("/contests/contest_type", async (req, res) => {
      const cursor = contestsCollection.find(
        { status: "approved" },
        { projection: { contest_type: 1 } }
      );

      const contests = await cursor.toArray();

      // duplicate remove
      const types = [...new Set(contests.map((c) => c.contest_type))];

      res.send(types);
    });

    // POST
    app.post("/contests", verifyFBToken, async (req, res) => {
      const contest = req.body;
      contest.creator_email = req.decoded_email;
      contest.status = "pending";
      contest.participants = 0;
      contest.winner = null;
      contest.createdAt = new Date();

      const result = await contestsCollection.insertOne(contest);
      res.send(result);
    });

    // GET Contest for contest details page
    app.get("/contests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!contest)
          return res.status(404).send({ message: "Contest not found" });
        res.send(contest);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Server error" });
      }
    });

    //  PATCH
    app.patch("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: updatedData,
      };
      const result = await contestsCollection.updateOne(query, update);
      res.send(result);
    });
    // Delete
    app.delete("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await contestsCollection.deleteOne(query);
      res.send(result);
    });

    //  payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.contestName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          contestId: paymentInfo.contestId,
        },
        customer_email: paymentInfo.userEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    //  payment post api to database
    app.post("/payments/confirm", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid") {
        return res.status(400).send({ message: "Payment not completed" });
      }
      const contestId = session.metadata.contestId;
      const email = session.customer_email;

      // save payment
      await paymentsCollection.insertOne({
        contestId,
        email,
        amount: session.amount_total / 100,
        sessionId,
        paidAt: new Date(),
      });
      // increase participants count
      await contestsCollection.updateOne(
        { _id: new ObjectId(contestId) },
        { $inc: { participants: 1 } }
      );
        //  user registered
      await contestsCollection.updateOne(
        { _id: new ObjectId(contestId) },
        { $addToSet: { registeredUsers: email } }
      );
        
      // navigate kora abr oi akoi details page a fira jete contestId client a patabo
      res.send({ success: true, contestId });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Contest Hub server  running!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
