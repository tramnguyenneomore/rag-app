/* Helper file to process and store vector embeddings in HANA Cloud */

const cds = require('@sap/cds');
const { INSERT, DELETE, SELECT } = cds.ql;
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { PDFLoader } = require('langchain/document_loaders/fs/pdf');
const { Readable } = require('stream');

// Helper method to convert stream to buffer
const streamToBuffer = async (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
};

// Helper method to convert embeddings to buffer for insertion
let array2VectorBuffer = (data) => {
  const sizeFloat = 4;
  const sizeDimensions = 4;
  const bufferSize = data.length * sizeFloat + sizeDimensions;

  const buffer = Buffer.allocUnsafe(bufferSize);
  // write size into buffer
  buffer.writeUInt32LE(data.length, 0);
  data.forEach((value, index) => {
    buffer.writeFloatLE(value, index * sizeFloat + sizeDimensions);
  });
  return buffer;
};

// Helper method to delete file if it already exists
const deleteIfExists = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('File deleted successfully:', filePath);
    }
  } catch (unlinkErr) {
    console.error('Error occurred while attempting to delete file:', unlinkErr);
  }
};

module.exports = function () {
  this.on('storeEmbeddings', async (req) => {
    try {
      console.log('Starting embedding generation process...');
      const { uuid } = req.data;
      const { Files, DocumentChunk } = this.entities;
      
      // Initialize database connection
      console.log('Connecting to database...');
      const db = await cds.connect.to('db');
      if (!db) {
        throw new Error('Failed to connect to database');
      }
      console.log('Database connection established');

      // Initialize CAP LLM plugin
      console.log('Connecting to CAP LLM plugin...');
      try {
        const capllmplugin = await cds.connect.to("cap-llm-plugin");
        if (!capllmplugin) {
          console.error('CAP LLM plugin connection returned null');
          throw new Error('Failed to connect to CAP LLM plugin - null connection');
        }
        console.log('CAP LLM plugin connection established');
        console.log('Plugin configuration:', JSON.stringify(cds.env.requires["cap-llm-plugin"]));
      } catch (error) {
        console.error('Error connecting to CAP LLM plugin:', error);
        console.error('Plugin configuration:', JSON.stringify(cds.env.requires["cap-llm-plugin"]));
        throw error;
      }

      let textChunkEntries = [];
      const embeddingModelName = "text-embedding-ada-002";

      // Check if document exists
      console.log('Checking if document exists...');
      const isDocumentPresent = await SELECT.from(Files).where({ ID: uuid });
      if (isDocumentPresent.length === 0) {
        throw new Error(`Document with uuid: ${uuid} not yet persisted in database!`);
      }
      console.log('Document found in database');

      // Load pdf from HANA and create a temp pdf doc
      console.log('Retrieving file information...');
      const fileName = await SELECT('fileName').from(Files).where({ ID: uuid });
      const fileNameString = fileName[0].fileName;
      const tempDir = path.join(__dirname, 'temp');
      
      // Create temp directory if it doesn't exist
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const tempDocLocation = path.join(tempDir, fileNameString);
      console.log('Temporary file location:', tempDocLocation);
      
      console.log("***********************************************************************************************\n");
      console.log(`Received the request to split the document ${fileNameString} and store it into SAP HANA Cloud!\n`);

      // Get the file content
      console.log('Retrieving file content...');
      const fileContent = await SELECT('content').from(Files).where({ ID: uuid });
      if (!fileContent || !fileContent[0] || !fileContent[0].content) {
        throw new Error('Failed to retrieve file content from database');
      }

      // Convert content to buffer if it's a stream
      let contentBuffer;
      if (fileContent[0].content instanceof Readable) {
        console.log('Converting stream to buffer...');
        contentBuffer = await streamToBuffer(fileContent[0].content);
      } else {
        contentBuffer = fileContent[0].content;
      }

      // Save the content to a temporary file
      console.log('Saving content to temporary file...');
      fs.writeFileSync(tempDocLocation, contentBuffer);
      console.log('Temporary PDF File restored and saved to:', tempDocLocation);

      // Delete existing embeddings 
      console.log('Deleting existing embeddings...');
      await DELETE.from(DocumentChunk);

      // Load the document to langchain text loader
      console.log('Loading PDF document...');
      const loader = new PDFLoader(tempDocLocation);
      const document = await loader.load();
      console.log('PDF document loaded successfully');

      // Split the document into chunks
      console.log("Splitting the document into text chunks...");
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1500,
        chunkOverlap: 150,
        addStartIndex: true
      });

      const textChunks = await splitter.splitDocuments(document);
      console.log(`Documents split into ${textChunks.length} chunks.`);

      console.log("Generating embeddings for text chunks...");
      // For each text chunk generate the embeddings
      for (const chunk of textChunks) {
        console.log('Processing chunk:', chunk.pageContent.substring(0, 50) + '...');
        const embeddingModelConfig = cds.env.requires["gen-ai-hub"][embeddingModelName];
        console.log('Embedding model config:', JSON.stringify(embeddingModelConfig));
        
        try {
          console.log('Calling getEmbeddingWithConfig...');
          const embeddingResult = await capllmplugin.getEmbeddingWithConfig(embeddingModelConfig, chunk.pageContent);
          console.log('Raw embedding result:', JSON.stringify(embeddingResult));
          
          let embedding = null;
          if (embeddingModelName === "text-embedding-ada-002") {
            if (!embeddingResult || !embeddingResult.data || !embeddingResult.data[0]) {
              console.error('Invalid embedding result structure:', embeddingResult);
              throw new Error('Invalid embedding result structure');
            }
            embedding = embeddingResult.data[0].embedding;
            if (!embedding) {
              console.error('No embedding found in result:', embeddingResult);
              throw new Error('Failed to get embedding from result');
            }
            console.log('Successfully extracted embedding of length:', embedding.length);
          } else {
            throw new Error(`Embedding model ${embeddingModelName} not supported!\n`);
          }

          const entry = {
            "text_chunk": chunk.pageContent,
            "metadata_column": fileNameString,
            "embedding": array2VectorBuffer(embedding)
          };
          textChunkEntries.push(entry);
        } catch (error) {
          console.error('Error while generating embedding:', error);
          throw error;
        }
      }

      console.log("Inserting text chunks with embeddings into SAP HANA Cloud's vector engine...");
      // Insert the text chunk with embeddings into db
      const insertStatus = await INSERT.into(DocumentChunk).entries(textChunkEntries);
      if (!insertStatus) {
        throw new Error("Insertion of text chunks into db failed!");
      }
      console.log(`RAG content generation for the document ${fileNameString} completed!\n`);
      
      // Delete temp document
      deleteIfExists(tempDocLocation);

    } catch (error) {
      console.error('Error while generating and storing vector embeddings:', error);
      throw error;
    }
    return "Embeddings stored successfully!";
  });

  this.on('deleteEmbeddings', async () => {
    try {
      console.log('Deleting embeddings...');
      const { DocumentChunk } = this.entities;
      await DELETE.from(DocumentChunk);
      return "Success!";
    } catch (error) {
      console.error('Error while deleting the embeddings content in db:', error);
      throw error;
    }
  });
};