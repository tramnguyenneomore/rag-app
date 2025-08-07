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

async function processChatQuery(req, capllmplugin, srv) {
    const { conversationId, messageId, message_time, user_id, user_query } = req.data;
    let responseText = '';

    try {
        console.log('[DEBUG] Processing query:', user_query);

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

        // Store the conversation
        const responseTimestamp = new Date().toISOString();
        const chatCompletionResponse = { role: 'assistant', content: responseText };
        await storeModelResponse(conversationId, responseTimestamp, chatCompletionResponse, srv.entities.Message, srv.entities.Conversation);

        return {
            role: 'assistant',
            content: responseText,
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