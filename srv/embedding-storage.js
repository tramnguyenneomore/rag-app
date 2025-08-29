/* Helper file to process and store vector embeddings in HANA Cloud */

const cds = require('@sap/cds');
const { INSERT, DELETE, SELECT, UPDATE } = cds.ql;
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
      let capllmplugin;
      try {
        capllmplugin = await cds.connect.to("cap-llm-plugin");
        if (!capllmplugin) {
          console.error('CAP LLM plugin connection returned null');
          throw new Error('Failed to connect to CAP LLM plugin - null connection');
        }
        console.log('CAP LLM plugin connection established');

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
      
      // First, let's check what fields are actually populated
      const fileInfo = await SELECT.from(Files).where({ ID: uuid });

      
      const fileContent = await SELECT('content').from(Files).where({ ID: uuid });

      
      if (!fileContent || fileContent.length === 0) {
        throw new Error(`No file records found for UUID: ${uuid}`);
      }
      
      if (!fileContent[0]) {
        throw new Error(`File record is null/undefined for UUID: ${uuid}`);
      }
      

      
      if (!fileContent[0].content) {
        throw new Error(`File content is ${fileContent[0].content === null ? 'null' : 'undefined'} for UUID: ${uuid}. The file may not have been uploaded yet or the upload failed.`);
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

      // Delete existing embeddings for this specific document
      console.log('Deleting existing embeddings for this document...', fileNameString);
      await DELETE.from(DocumentChunk).where({ metadata_column: { like: fileNameString } });

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

      // Create a mapping from original documents to page numbers for fallback
      const pageContentToPageMap = new Map();
      document.forEach((doc, index) => {
        let pageNum = null;
        if (doc.metadata && doc.metadata.page !== undefined) {
          pageNum = doc.metadata.page;
        } else if (doc.metadata && doc.metadata.loc && doc.metadata.loc.pageNumber !== undefined) {
          pageNum = doc.metadata.loc.pageNumber;
        }
        
        if (pageNum !== null) {
          pageContentToPageMap.set(doc.pageContent, pageNum);
        }
      });


      console.log("Generating embeddings for text chunks...");
      // For each text chunk generate the embeddings
      for (const chunk of textChunks) {
        console.log('Processing chunk:', chunk.pageContent.substring(0, 50) + '...');
        const embeddingModelConfig = cds.env.requires["gen-ai-hub"][embeddingModelName];
        
        try {
          const embeddingResult = await capllmplugin.getEmbeddingWithConfig(embeddingModelConfig, chunk.pageContent);
          
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

          } else {
            throw new Error(`Embedding model ${embeddingModelName} not supported!\n`);
          }

          // Extract page number from chunk metadata or fallback to mapping
          let pageNumber = null;
          
          // Try different possible locations for page information
          if (chunk.metadata && chunk.metadata.page !== undefined) {
            pageNumber = chunk.metadata.page;

          } else if (chunk.metadata && chunk.metadata.loc && chunk.metadata.loc.pageNumber !== undefined) {
            pageNumber = chunk.metadata.loc.pageNumber;

          } else {
            // Fallback: try to find page by matching chunk content with original documents
            for (const [pageContent, page] of pageContentToPageMap.entries()) {
              if (chunk.pageContent.includes(pageContent.substring(0, 100)) || 
                  pageContent.includes(chunk.pageContent.substring(0, 100))) {
                pageNumber = page;

                break;
              }
            }
          }


          const entry = {
            "text_chunk": chunk.pageContent,
            "metadata_column": fileNameString,
            "page": pageNumber,
            "embedding": array2VectorBuffer(embedding),
            "file_ID_ID": uuid  // Set the file association properly
          };
          textChunkEntries.push(entry);
        } catch (error) {
          console.error('Error while generating embedding:', error);
          throw error;
        }
      }

      console.log("Inserting text chunks with embeddings into SAP HANA Cloud's vector engine...");
      console.log(`[EMBEDDING CREATION] About to insert ${textChunkEntries.length} chunks for file ID: ${uuid}`);
      
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

  // Global embedding deletion function - USE WITH CAUTION
  // This deletes ALL embeddings in the system, not just for specific files
  // Individual file deletions now automatically cascade delete their embeddings
  this.on('deleteEmbeddings', async () => {
    try {
      console.log('[GLOBAL DELETE] Deleting ALL embeddings in the system...');
      const { DocumentChunk } = this.entities;
      const countBefore = await SELECT.from(DocumentChunk, ['ID']);
      console.log(`[GLOBAL DELETE] Found ${countBefore.length} total embeddings to delete`);
      
      await DELETE.from(DocumentChunk);
      
      console.log('[GLOBAL DELETE] All embeddings deleted successfully');
      return `Success! Deleted ${countBefore.length} embeddings.`;
    } catch (error) {
      console.error('[GLOBAL DELETE] Error while deleting all embeddings:', error);
      throw error;
    }
  });

  // Handle DELETE events for Files entity to ensure cascade delete of DocumentChunk
  this.before('DELETE', 'Files', async (req) => {
    try {
      const { Files, DocumentChunk } = this.entities;
      const fileIds = [];
      
      // Handle individual file deletion by ID (e.g., DELETE /Files(id))
      if (req.params && req.params.length > 0) {
        const fileId = req.params[0].ID || req.params[0];
        if (fileId) {
          fileIds.push(fileId);
        }
      }
      // Handle query-based deletion (e.g., DELETE FROM Files WHERE ...)
      else if (req.query && req.query.SELECT && req.query.SELECT.where) {
        const whereClause = req.query.SELECT.where;
        
        // Handle different types of where clauses
        if (Array.isArray(whereClause)) {
          // Complex where clause - find ID conditions
          for (const condition of whereClause) {
            if (condition.ref && condition.ref[0] === 'ID' && condition.val) {
              fileIds.push(condition.val);
            }
          }
        } else if (whereClause.ref && whereClause.ref[0] === 'ID' && whereClause.val) {
          // Simple where clause
          fileIds.push(whereClause.val);
        }
        
        // If we couldn't extract IDs from where clause, get all files that match the query
        if (fileIds.length === 0) {
          const filesToDelete = await SELECT.from(Files, ['ID']).where(req.query.SELECT.where);
          fileIds.push(...filesToDelete.map(file => file.ID));
        }
      }
      
      // Delete associated DocumentChunk records for each file
      if (fileIds.length > 0) {
        console.log(`[CASCADE DELETE] Processing ${fileIds.length} file(s) for DocumentChunk cleanup...`);
        
        for (const fileId of fileIds) {
          // Count chunks before deletion for logging
          // Use the correct association field name that CAP generates
          const chunkCount = await SELECT.from(DocumentChunk).where({ file_ID_ID: fileId });
          console.log(`[CASCADE DELETE] Found ${chunkCount.length} DocumentChunk records for file ${fileId}`);
          
          if (chunkCount.length > 0) {
            // Delete the chunks using the correct field name
            await DELETE.from(DocumentChunk).where({ file_ID_ID: fileId });
            console.log(`[CASCADE DELETE] Successfully deleted ${chunkCount.length} DocumentChunk records for file ${fileId}`);
          }
        }
      }
      
    } catch (error) {
      console.error('[CASCADE DELETE] Error during DocumentChunk cleanup:', error);
      // Log error but don't throw to avoid blocking the file deletion
      // The composition should handle the cascade delete as fallback
    }
  });

  // Function to clean up orphaned DocumentChunk records (chunks without corresponding files)
  this.on('cleanupOrphanedChunks', async () => {
    try {
      console.log('Starting cleanup of orphaned DocumentChunk records...');
      const { Files, DocumentChunk } = this.entities;
      
      // Find all DocumentChunk records
      const allChunks = await SELECT.from(DocumentChunk, ['ID', 'file_ID_ID', 'metadata_column']);
      console.log(`Found ${allChunks.length} total DocumentChunk records`);
      
      if (allChunks.length === 0) {
        return "No DocumentChunk records found.";
      }
      
      // Get all existing file IDs
      const existingFiles = await SELECT.from(Files, ['ID']);
      const existingFileIds = new Set(existingFiles.map(file => file.ID));
      console.log(`Found ${existingFileIds.size} existing Files records`);
      
      // Find orphaned chunks (chunks whose file_ID_ID doesn't exist in Files table)
      const orphanedChunks = allChunks.filter(chunk => 
        chunk.file_ID_ID && !existingFileIds.has(chunk.file_ID_ID)
      );
      
      console.log(`Found ${orphanedChunks.length} orphaned DocumentChunk records`);
      
      if (orphanedChunks.length === 0) {
        return `Cleanup complete. No orphaned chunks found. Total chunks: ${allChunks.length}`;
      }
      
      // Delete orphaned chunks
      for (const chunk of orphanedChunks) {
        await DELETE.from(DocumentChunk).where({ ID: chunk.ID });
        console.log(`Deleted orphaned chunk ${chunk.ID} (file_ID: ${chunk.file_ID_ID}, metadata: ${chunk.metadata_column})`);
      }
      
      const remainingChunks = await SELECT.from(DocumentChunk, ['ID']);
      
      return `Cleanup complete. Deleted ${orphanedChunks.length} orphaned chunks. Remaining chunks: ${remainingChunks.length}`;
      
    } catch (error) {
      console.error('Error during orphaned chunk cleanup:', error);
      throw error;
    }
  });

  // Function to fix existing DocumentChunk records that have null file_ID_ID
  // This is a one-time migration function
  this.on('fixNullFileIds', async () => {
    try {
      console.log('Starting fix for DocumentChunk records with null file_ID_ID...');
      const { Files, DocumentChunk } = this.entities;
      
      // Find all DocumentChunk records with null file_ID_ID but have metadata_column
      const chunksWithNullFileId = await SELECT.from(DocumentChunk, ['ID', 'metadata_column']).where({ file_ID_ID: null });
      console.log(`Found ${chunksWithNullFileId.length} DocumentChunk records with null file_ID_ID`);
      
      if (chunksWithNullFileId.length === 0) {
        return "No DocumentChunk records with null file_ID_ID found.";
      }
      
      let fixedCount = 0;
      let unfixableCount = 0;
      
      // Group chunks by metadata_column (filename)
      const chunksByFilename = {};
      chunksWithNullFileId.forEach(chunk => {
        if (!chunksByFilename[chunk.metadata_column]) {
          chunksByFilename[chunk.metadata_column] = [];
        }
        chunksByFilename[chunk.metadata_column].push(chunk);
      });
      
      // For each filename, try to find the corresponding file and update chunks
      for (const [filename, chunks] of Object.entries(chunksByFilename)) {
        console.log(`Processing ${chunks.length} chunks for file: ${filename}`);
        
        // Find the file with this filename
        const matchingFiles = await SELECT.from(Files, ['ID']).where({ fileName: filename });
        
        if (matchingFiles.length === 1) {
          // Update all chunks for this file
          const fileId = matchingFiles[0].ID;
          console.log(`Updating ${chunks.length} chunks to file ID: ${fileId}`);
          
          for (const chunk of chunks) {
            await UPDATE(DocumentChunk).set({ file_ID_ID: fileId }).where({ ID: chunk.ID });
            fixedCount++;
          }
        } else if (matchingFiles.length === 0) {
          console.log(`No file found for filename: ${filename}, cannot fix ${chunks.length} chunks`);
          unfixableCount += chunks.length;
        } else {
          console.log(`Multiple files found for filename: ${filename}, cannot fix ${chunks.length} chunks`);
          unfixableCount += chunks.length;
        }
      }
      
      return `Fix complete. Fixed ${fixedCount} chunks, ${unfixableCount} chunks could not be fixed automatically.`;
      
    } catch (error) {
      console.error('Error during null file_ID fix:', error);
      throw error;
    }
  });
};