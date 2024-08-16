const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const productCollection = client.db("emaJohnDB").collection("products");
    const orderCollection = client.db("emaJohnDB").collection("orders");

    // Stripe Checkout: create payment intent and session
    app.post("/create-payment-intent", async (req, res) => {
      const { products, customerDetails } = req.body;

      const lineItems = products.map((product) => ({
        price_data: {
          currency: "usd",
          product_data: { name: product.name },
          unit_amount: product.price * 100,
        },
        quantity: product.quantity,
      }));

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: lineItems,
        mode: "payment",
        success_url: "http://localhost:5173/success",
        cancel_url: "http://localhost:5173/cancel",
      });

      const orderDetails = {
        products,
        totalAmount: products.reduce((sum, product) => sum + product.price * product.quantity, 0),
        sessionId: session.id,
        customerDetails,
        status: "pending",
        createdAt: new Date(),
      };

      await orderCollection.insertOne(orderDetails);

      res.send({ id: session.id });
    });

    // Webhook: handle successful payment and save payment method details
    app.post(
      "/webhook",
      express.raw({ type: "application/json" }),
      async (req, res) => {
        const sig = req.headers["stripe-signature"];

        let event;
        try {
          event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
          console.error(`Webhook Error: ${err.message}`);
          return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // Handle the checkout.session.completed event
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;

          // Add delay to ensure Stripe updates the payment intent
          setTimeout(async () => {
            try {
              // Retrieve the payment intent to get payment method details
              const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);

              // Check if charges exist and get the payment method details
              if (paymentIntent.charges.data.length > 0) {
                const paymentMethod = paymentIntent.charges.data[0].payment_method_details;

                // Update the order with payment method details
                await orderCollection.updateOne(
                  { sessionId: session.id },
                  {
                    $set: {
                      status: "completed",
                      paymentIntentId: session.payment_intent,
                      paymentMethod: {
                        type: paymentMethod.type,
                        brand: paymentMethod.card?.brand,
                        last4: paymentMethod.card?.last4,
                        country: paymentMethod.card?.country,
                      },
                    },
                  }
                );
              } else {
                console.error("No charges found for the payment intent.");
              }
            } catch (error) {
              console.error("Error retrieving payment intent:", error);
            }
          }, 5000); // Add 5 seconds delay
        }

        res.status(200).json({ received: true });
      }
    );

    // Product-related endpoints
    app.post("/products", async (req, res) => {
      const result = await productCollection.insertOne(req.body);
      res.send(result);
    });

    app.get("/products", async (req, res) => {
      const page = parseInt(req.query.page) || 0;
      const limit = parseInt(req.query.limit) || 10;
      const skip = page * limit;

      const result = await productCollection.find().skip(skip).limit(limit).toArray();
      res.send(result);
    });

    app.get("/totalProducts", async (req, res) => {
      const result = await productCollection.estimatedDocumentCount();
      res.send({ totalProducts: result });
    });

    // Ping to confirm connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. Successfully connected to MongoDB!");
  } finally {
    // Ensure the client closes when done
    // await client.close();
  }
}

run().catch(console.dir);

// Raw body parsing for Stripe webhook
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/", (req, res) => {
  res.send("ema is busy");
});

app.listen(port, () => {
  console.log("app is running on port", port);
});
