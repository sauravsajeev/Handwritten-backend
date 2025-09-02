
require("dotenv").config()
const mongoose = require("mongoose")
const Document = require("./models/Document")
const express = require("express")
const cors = require("cors")
const app = express()
const server = require("http").Server(app)
const io = require("socket.io")(server, {
  cors: {
    origin: "https://handwrittenocr.netlify.app",
    methods: ["GET", "POST"],
    credentials: true
  },
})
const axios = require("axios")
const { OAuth2Client } = require("google-auth-library")
const querystring = require("querystring")

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const REDIRECT_URI = process.env.REDIRECT_URI   // e.g., "http://localhost:9000/auth/google/callback"
const FRONTEND_URL = process.env.FRONTEND_URL 
const PORT = process.env.PORT || 9000
const MONGO_CONNECTION_URL = process.env.MONGO_CONNECTION_URL


// === Connect to MongoDB Atlas ===
mongoose
  .connect(
    MONGO_CONNECTION_URL,
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  )
  .then(() => console.log("✅ MongoDB connected successfully"))
  .catch((error) => console.error("❌ MongoDB connection error:", error))

const connection = mongoose.connection
connection.once("open", () => {
  console.log("✅ Database is ready to use...")
})
connection.on("error", (err) => {
  console.error("MongoDB error:", err)
})

// === Middlewares ===
app.use(cors())
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(cors({
  origin: "https://handwrittenocr.netlify.app",
  methods: ["GET", "POST"],
  credentials: true
}));
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  res.removeHeader("Cross-Origin-Embedder-Policy"); // optional, prevents isolation
  next();
});

// === Routes ===
app.get("/", async (req, res) => {
  try {
    const documents = await Document.find()
    return res.json(documents)
  } catch (err) {
    console.log(err)
    return res.json(null)
  }
})
// Step 1: Redirect user to Google's consent screen
app.get("/auth/google/login", (req, res) => {
  const googleAuthUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    querystring.stringify({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "consent"
    })

  res.redirect(googleAuthUrl)
})

// Step 2: Handle callback from Google
app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code
  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" })
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", null, {
      params: {
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      },
    })

    const tokens = tokenResponse.data

    if (!tokens.id_token) {
      return res.status(400).json({ error: tokens })
    }

    // Verify ID token
    const client = new OAuth2Client(GOOGLE_CLIENT_ID)
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()

    // Build query params to send user info + tokens to frontend
    const params = querystring.stringify({
      email: payload.email,
      name: payload.name,
      google_id: payload.sub,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || "",
    })

    const redirectUrl = `${FRONTEND_URL}/?${params}`

    // Redirect user to frontend with query params
    res.redirect(redirectUrl)
  } catch (err) {
    console.error("Google OAuth Error:", err.response?.data || err.message)
    res.status(500).json({ error: "OAuth callback failed" })
  }
})
// === Socket.io Events ===
io.on("connection", (socket) => {
  console.log("⚡ A client connected:", socket.id)
  socket.on("find-all", async (ownerid) => {
      console.log("Finding all docs for owner:", ownerid)
      const documents = await getDocumentsByOwner(ownerid)
      socket.emit("all-documents", documents)
    })
  socket.on("get-document", async (documentId,ownerid) => {
    console.log(`Client ${socket.id} requested document:`, documentId)
    const document = await findOrCreateDocument(documentId,ownerid)
    const message = "Document"
    socket.join(documentId)
    if (document.owner == ownerid){
       socket.emit("load-document", document)
    }
    else{
       socket.emit("load-document", message)
    }
    // Rename doc
    socket.on("rename-document", async (name) => {
      try {
        await Document.findByIdAndUpdate(documentId, { name })
      } catch (err) {
        console.log(err)
      }
    })
   
    // Handle content changes
    socket.on("send-changes", (delta) => {
      socket.broadcast.to(documentId).emit("receive-changes", delta)
    })

    // Save doc
    socket.on("save-document", async (data) => {
      try {
        await Document.findByIdAndUpdate(documentId, { data })
      } catch (err) {
        console.log(err)
      }
    })

    // Add new page
    socket.on("add-page", async () => {
      try {
        const document = await Document.findById(documentId)
        if (document) {
          const newPageNumber = document.pages.length + 1
          document.pages.push({ pageNumber: newPageNumber, content: {} })
          await document.save()
          socket.emit("page-added", { pageNumber: newPageNumber, pages: document.pages })
          socket.broadcast.to(documentId).emit("page-added", { pageNumber: newPageNumber, pages: document.pages })
        }
      } catch (err) {
        console.log(err)
      }
    })

    // Delete page
    socket.on("delete-page", async (pageNumber) => {
      try {
        const document = await Document.findById(documentId)
        if (document && document.pages.length > 1) {
          document.pages = document.pages.filter((page) => page.pageNumber !== pageNumber)
          // Renumber remaining pages
          document.pages.forEach((page, index) => {
            page.pageNumber = index + 1
          })
          await document.save()
          socket.emit("page-deleted", { deletedPage: pageNumber, pages: document.pages })
          socket.broadcast.to(documentId).emit("page-deleted", { deletedPage: pageNumber, pages: document.pages })
        }
      } catch (err) {
        console.log(err)
      }
    })

    // Save specific page content
    socket.on("save-page", async ({ pageNumber, content }) => {
      try {
        const document = await Document.findById(documentId)
        if (document) {
          const page = document.pages.find((p) => p.pageNumber === pageNumber)
          if (page) {
            page.content = content
            await document.save()
          }
        }
      } catch (err) {
        console.log(err)
      }
    })

    // Load specific page content
    socket.on("load-page", async (pageNumber) => {
      try {
        const document = await Document.findById(documentId)
        if (document) {
          const page = document.pages.find((p) => p.pageNumber === pageNumber)
          socket.emit("page-loaded", { pageNumber, content: page ? page.content : {} })
        }
      } catch (err) {
        console.log(err)
      }
    })
  })

  // Delete doc
  socket.on("delete-document", async (id) => {
    try {
      await Document.deleteOne({ _id: id })
    } catch (err) {
      console.log(err)
    }
  })

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id)
  })
})

async function getDocumentsByOwner(ownerid) {
  if (!ownerid) return []
  try {
    const documents = await Document.find({ owner: ownerid })
    return documents
  } catch (err) {
    console.log("Error fetching documents by owner:", err)
    return []
  }
}
// === Utility: Find or create a document ===
async function findOrCreateDocument(id,ownerid) {
  if (id == null) return
  try {
    const document = await Document.findById(id)
    if (document) return document

    // Create new doc with 1 default page
    return await Document.create({
      _id: id,
      name: `Doc-${id}`,
      owner: ownerid,
      pages: [{ pageNumber: 1, content: {} }],
    })
  } catch (err) {
    console.log(err)
  }
}

// === Start server ===
server.listen(PORT, (err) => {
  if (err) console.log(err)
  console.log(`🚀 Server listening on PORT ${PORT}`)
})
