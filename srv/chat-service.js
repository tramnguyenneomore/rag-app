/* Main implementation file for handling chat */

require('dotenv').config();
const cds = require('@sap/cds');
const { DELETE, UPDATE, SELECT } = cds.ql;
const { storeRetrieveMessages, storeModelResponse } = require('./memory-helper');

// Constants and configurations
const CHAT_CONFIG = {
    modelName: "gpt-4",
    embeddingModelName: "text-embedding-ada-002",
    tableName: 'SAP_TISCE_DEMO_DOCUMENTCHUNK',
    embeddingColumn: 'EMBEDDING',
    contentColumn: 'TEXT_CHUNK'
};

const systemPrompt = `You are a helpful assistant who answers user questions based on the provided context. Always respond in the same language as the user's question. If the context doesn't contain relevant information, you can use your general knowledge, but make it clear to the user that you're using information outside of the provided context.\n`;

// Helper function for intelligent post-processing to identify which chunks were actually used
async function identifyUsedSources(answer, retrievedChunks, userQuery, capllmplugin, chatModelConfig) {
    if (!retrievedChunks || retrievedChunks.length === 0) {
        return [];
    }

    // Starting intelligent source identification

    const usedSources = [];

    // Analyze each chunk individually to see if it contributed to the answer
    for (let i = 0; i < retrievedChunks.length; i++) {
        const chunk = retrievedChunks[i];
        // Analyzing chunk for source identification

        const analysisPrompt = `You are analyzing whether a specific source chunk was used to generate an answer.

User Query: "${userQuery}"
Generated Answer: "${answer}"

Source Chunk to Analyze:
Content: "${chunk.PAGE_CONTENT}"
Source: ${chunk.METADATA_COLUMN}, Page: ${chunk.PAGE}

Instructions:
1. Carefully compare the generated answer with the source chunk content
2. Determine if any part of the answer was derived from or supported by this specific chunk
3. Look for:
   - Direct information matches
   - Conceptual matches where the chunk supports the answer's claims
   - Terminology or specific details that appear in both
4. Ignore chunks that are only tangentially related

Respond with ONLY one of these options:
- true: if this chunk clearly contributed to the answer
- false: if this chunk did not contribute to the answer

Response:`;

        try {

            const analysisResponse = await capllmplugin.getChatCompletionWithConfig(
                chatModelConfig,
                {
                    messages: [
                        { role: 'user', content: analysisPrompt }
                    ],
                    max_tokens: 200,
                    temperature: 0
                }
            );

           
            const result = analysisResponse.choices[0].message.content;
            if (result === 'true') {
                usedSources.push({
                    chunkIndex: i,
                    source: chunk.METADATA_COLUMN || 'Unknown Document',
                    page: chunk.PAGE ? chunk.PAGE.toString() : 'Unknown',
                    score: chunk.SCORE,
                    content: chunk.PAGE_CONTENT.substring(0, 200) + '...'
                });
            }
        } catch (error) {
            // If analysis fails, we'll skip this chunk rather than assume it was used
            console.error('Error during source analysis:', error.message);
        }
    }

    // Source identification completed

    return usedSources;
}

async function processChatQuery(req, capllmplugin, srv) {
    const { conversationId, messageId, message_time, user_id, user_query } = req.data;
    let responseText = '';

    try {

        // Get memory context
        const memoryContext = await storeRetrieveMessages(
            conversationId,
            messageId,
            message_time,
            user_id,
            user_query,
            srv.entities.Conversation,
            srv.entities.Message,
            CHAT_CONFIG.modelName
        );

        // Get RAG response
        const ragPrompt = `Based on the following context and user query, provide a direct, human-friendly response.
IMPORTANT: You MUST respond in the EXACT SAME LANGUAGE as the user's query, even if the context is in a different language. If the context is in another language, translate it to match the user's query language.

User Query: "${user_query}"

Please provide a helpful response based on the available context and general knowledge. Make it clear if you're using information outside of the provided context.`;

        const chatModelConfig = cds.env.requires["gen-ai-hub"][CHAT_CONFIG.modelName];
        const embeddingModelConfig = cds.env.requires["gen-ai-hub"][CHAT_CONFIG.embeddingModelName];

        const chatRagResponse = await capllmplugin.getRagResponseWithConfig(
            ragPrompt,
            CHAT_CONFIG.tableName,
            CHAT_CONFIG.embeddingColumn,
            CHAT_CONFIG.contentColumn,
            systemPrompt,
            embeddingModelConfig,
            chatModelConfig,
            memoryContext.length > 0 ? memoryContext : undefined,
            5
        );

        responseText = chatRagResponse.completion.choices[0].message.content;

        // Intelligent post-processing: identify which sources were actually used
        const usedSources = await identifyUsedSources(
            responseText,
            chatRagResponse.additionalContents,
            user_query,
            capllmplugin,
            chatModelConfig
        );

        // Format citations for display in UI
        let citationsText = '';
        if (usedSources.length > 0) {
            citationsText = '\n\n**Sources:**\n' + 
                usedSources.map(source => 
                    `• ${source.source}, page ${source.page}`
                ).join('\n');
        }

        // Add citations to the response text for UI display
        const responseWithCitations = responseText + citationsText;

        // Store the conversation
        const responseTimestamp = new Date().toISOString();
        const chatCompletionResponse = { role: 'assistant', content: responseWithCitations };
        await storeModelResponse(conversationId, responseTimestamp, chatCompletionResponse, srv.entities.Message, srv.entities.Conversation);

        return {
            role: 'assistant',
            content: responseWithCitations,
            messageTime: responseTimestamp,
            additionalContents: chatRagResponse.additionalContents
        };
    } catch (error) {
        console.error('Error in chat handler:', error);
        throw error;
    }
}

module.exports = async function (srv) {
    const capllmplugin = await cds.connect.to('cap-llm-plugin');
    const db = await cds.connect.to('db');

    srv.on('chat', async (req) => {
        return await processChatQuery(req, capllmplugin, srv);
    });

    srv.on('getChatRagResponse', async (req) => {
        return await processChatQuery(req, capllmplugin, srv);
    });

    this.on('deleteChatData', async () => {
        try {
            const { Conversation, Message } = this.entities;
            await DELETE.from(Conversation);
            await DELETE.from(Message);
            return "Success!"
        }
        catch (error) {
            console.error('Error while deleting the chat content in db:', error);
            throw error;
        }
    });

    this.on('READ', 'Conversation', async (req) => {
        return await SELECT.from(this.entities.Conversation);
    });
}