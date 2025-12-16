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
    app.get("/users", verifyFBToken, async (req, res) => {
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
    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // PATCH
    app.patch("/users/:id/role", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const query = { _id: new ObjectId(id) };

      const updatedUser = { $set: { role } };
      const result = await usersCollection.updateOne(query, updatedUser);
      res.send(result);
    });

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

    // GET contest by  contest types
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
    app.patch("/contests/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: updatedData,
      };
      const result = await contestsCollection.updateOne(query, update);
      res.send(result);
    });

    // get all submissions for a contest
    app.get("/contests/:id/submissions", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const contest = await contestsCollection.findOne(query);
      // only creator of this contest can see submission check
      if (contest.creator_email !== req.decoded_email) {
        return res.status(403).send({ message: "Access denied" });
      }

      res.send({
        submissions: contest.submissions || [],
        winner: contest.winner || null,
        deadline: contest.deadline,
      });
    });

    // submit task post apis
    app.post("/contests/:id/submit-task", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const submissionData = req.body;

      const query = { _id: new ObjectId(id) };
      // check id contest exist
      const contest = await contestsCollection.findOne(query);
      if (!contest) {
        return res.status(403).send({ message: "Contest not found" });
      }
      //  deadline passed
      if (new Date(contest.deadline) < new Date()) {
        return res
          .status(400)
          .send({ message: "Submission closed. Deadline passed." });
      }

      //  not registered
      if (!contest.registeredUsers?.includes(submissionData.email)) {
        return res
          .status(403)
          .send({ message: "You are not registered for this contest" });
      }

      // only registered use can send submit check
      if (!contest.registeredUsers?.includes(submissionData.email)) {
        return res
          .status(403)
          .send({ message: "You are not registered for this contest " });
      }
      // Add submission
      const submission = {
        name: submissionData.name,
        email: submissionData.email,
        photo: submissionData.photo,
        taskInfo: submissionData.taskInfo,
        createdAt: new Date(),
      };
      const result = await contestsCollection.updateOne(query, {
        $addToSet: { submissions: submission },
      });
      res.send({
        success: true,
        message: "Task submitted successfully",
        result,
      });
    });

    // patch declare winner
    app.patch(
      "/contests/:id/declare-winner",
      verifyFBToken,
      async (req, res) => {
        const id = req.params.id;
        const { winnerEmail } = req.body;
        const query = { _id: new ObjectId(id) };

        const contest = await contestsCollection.findOne(query);
        if (!contest)
          return res.status(404).send({ message: "Contest not found" });
        // only creator
        if (contest.creator_email !== req.decoded_email) {
          return res.status(403).send({ message: "Access denied" });
        }

        //  winner already declared
        if (contest.winner) {
          return res.status(400).send({ message: "Winner already declared" });
        }

        // Check if deadline has passed
        const now = new Date();
        if (new Date(contest.deadline) > now) {
          return res
            .status(400)
            .send({ message: "Cannot declare winner before contest deadline" });
        }

        const winnerSubmission = (contest.submissions || []).find(
          (sub) => sub.email === winnerEmail
        );
        if (!winnerSubmission) {
          return res
            .status(400)
            .send({ message: "Winner submission not found" });
        }

        const winnerData = {
          name: winnerSubmission.name,
          email: winnerSubmission.email,
          photo: winnerSubmission.photo || "",
          taskInfo: winnerSubmission.taskInfo,
        };

        const result = await contestsCollection.updateOne(query, {
          $set: { winner: winnerData },
        });

        res.send({
          success: true,
          message: "Winner declared successfully",
          result,
        });
      }
    );

    // Delete
    app.delete("/contests/:id", verifyFBToken, async (req, res) => {
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

    // user ar payment history get
    app.get("/my-participated-contests", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      // payment collection ar modde user email find
      const payments = await paymentsCollection.find({ email }).toArray();

      // payment ar array te oi contest ar id map kora ber kora
      const contestIds = payments.map((p) => new ObjectId(p.contestId));

      const contests = await contestsCollection
        .find({ _id: { $in: contestIds } })
        .sort({ deadline: 1 })
        .toArray();

      res.send(contests);
    });

    //  my winning contest apis
    app.get("/my-winning-contests", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;

      const contests = await contestsCollection
        .find({
          "winner.email": email,
        })
        .toArray();

      res.send(contests);
    });

    // get my profile
    app.get("/my-profile", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;

      const participated = await paymentsCollection.countDocuments({ email });
      const wins = await contestsCollection.countDocuments({
        "winner.email": email,
      });

      const user = await usersCollection.findOne({ email });

      res.send({
        user,
        participated,
        wins,
        winPercentage: participated
          ? Math.round((wins / participated) * 100)
          : 0,
      });
    });

    // update profile
    app.patch("/my-profile", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const update = { $set: req.body };

      const result = await usersCollection.updateOne({ email }, update);
      res.send(result);
    });

    // leaderboard
    // GET leaderboard
    app.get("/leaderboard", async (req, res) => {
      const pipeline = [
        {
          // only contests with winners
          $match: { "winner.email": { $exists: true } },
        },
        {
          $group: {
            _id: "$winner.email",
            name: { $first: "$winner.name" },
            photo: { $first: "$winner.photo" },
            wins: { $sum: 1 },
          },
        },
        // top 20 winners
        { $sort: { wins: -1 } },
        { $limit: 20 },
      ];

      const leaderboard = await contestsCollection
        .aggregate(pipeline)
        .toArray();
      res.send(leaderboard); // array
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
