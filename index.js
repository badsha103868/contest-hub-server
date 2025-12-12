const express = require('express');
const cors = require('cors');
const app = express()
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 3000;



// middleware
app.use(express.json());
app.use(cors());
 
// mongodb connection string
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@portfolio-cluster1.ea8n2bl.mongodb.net/?appName=portfolio-cluster1`

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

    const db = client.db("contestHubDB")
    const contestsCollection = db.collection("contests")
    const paymentsCollection = db.collection('payments')
    const usersCollection = db.collection("users")
   

    //  users related apis 
    
    //    GET
    app.get('/users', async (req, res)=>{
        const cursor = usersCollection.find()
        const result = await cursor.toArray()
        res.send(result)
    } )

    //   POST
    app.post('/users', async(req, res)=>{
       const user = req.body;
       user.role = "user";
       user.createdAt = new Date();
       const email = user.email;
       const existsUser = await usersCollection.findOne({ email })
       if(existsUser){
        return res.send({message: "user exists"});
       }
       const result = await usersCollection.insertOne(user)
       res.send(result)
    })
    
    // PATCH
   app.patch('/users/:id/role', async(req, res)=>{
     const id = req.params.id;
      const { role } = req.body; 
     const query = {_id : new ObjectId(id)}
     
     const updatedUser = { $set: { role } };
     const result = await usersCollection.updateOne(query, updatedUser)
     res.send(result)
   })

  //  contests related apis 

  //    GET ALL Contests
  app.get('/contests', async(req, res) =>{
     const cursor = contestsCollection.find()
     const result = await cursor.toArray()
     res.send(result)
  })

    // POST
  app.post('/contests', async(req,res)=>{
      const contest = req.body;
      const result = await contestsCollection.insertOne(contest)
      res.send(result)
  })



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
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
