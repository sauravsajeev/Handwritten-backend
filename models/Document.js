
const { Schema, model } = require("mongoose")

const Document = new Schema({
  _id: String,
  name: String,
  owner:String,
  pages: [
    {
      pageNumber: Number,
      content: Object,
    },
  ],
})

module.exports = model("Document", Document)
