
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
  },
})


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
