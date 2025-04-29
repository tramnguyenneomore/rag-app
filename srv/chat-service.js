/* Main implementation file for handling chat */

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const cds = require('@sap/cds');
const { DELETE } = cds.ql;
const { storeRetrieveMessages, storeModelResponse } = require('./memory-helper');

const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

const systemPrompt =
    `You are a helpful assistant who answers user questions based only on the following context enclosed in triple quotes.\n`;

// Helper to fetch maintenance order details from OData API
async function fetchMaintenanceOrder(orderId) {
    const url = `https://172.16.0.64:8443/sap/opu/odata/sap/API_MAINTENANCEORDER/MaintenanceOrder('${orderId}')`;
    const username = process.env.ODATA_API_USERNAME;
    const password = process.env.ODATA_API_PASSWORD;

    try {
        const response = await axios.get(url, {
            auth: { username, password },
            headers: { 'Accept': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }) // For self-signed certs
        });
        return response.data;
    } catch (error) {
        console.error(`[OData] Error fetching order ${orderId}:`, error.response ? error.response.data : error.message);
        throw error;
    }
}

// Helper to flatten order data for LLM context
function flattenOrderData(orderData) {
    if (!orderData) return '';
    return Object.entries(orderData)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
}

module.exports = function () {

    this.on('getChatRagResponse', async (req) => {
        try {
            const { conversationId, messageId, message_time, user_id, user_query } = req.data;
            const { Conversation, Message } = this.entities;
            const capllmplugin = await cds.connect.to("cap-llm-plugin");
            console.log("***********************************************************************************************\n");
            console.log(`Received the request for RAG retrieval for the user query : ${user_query}\n`);

            const chatModelName = "gpt-4";
            const embeddingModelName = "text-embedding-ada-002";

            // Memory context
            const memoryContext = await storeRetrieveMessages(conversationId, messageId, message_time, user_id, user_query, Conversation, Message, chatModelName);

            // Model configs
            const chatModelConfig = cds.env.requires["gen-ai-hub"][chatModelName];
            const embeddingModelConfig = cds.env.requires["gen-ai-hub"][embeddingModelName];

            // --- OData API Integration ---
            const orderMatch = user_query.match(/order\s*(\d+)/i);
            let orderContext = '';
            if (orderMatch) {
                const orderId = orderMatch[1];
                try {
                    const orderData = await fetchMaintenanceOrder(orderId);
                    orderContext = flattenOrderData(orderData.d);
                } catch (err) {
                    orderContext = `Could not retrieve details for order ${orderId}.`;
                }
            }

            // --- Combine system prompt and order context ---
            let systemPromptWithOrder = systemPrompt;
            if (orderContext) {
                systemPromptWithOrder += `\nOrder details:\n"""\n${orderContext}\n"""\n`;
            }

            // --- Existing RAG logic ---
            const chatRagResponse = await capllmplugin.getRagResponseWithConfig(
                user_query,
                tableName,
                embeddingColumn,
                contentColumn,
                systemPromptWithOrder, // <-- use the prompt with order data
                embeddingModelConfig,
                chatModelConfig,
                memoryContext.length > 0 ? memoryContext : undefined,
                5
            );

            let chatCompletionResponse = null;
            if (chatModelName === "gpt-4") {
                chatCompletionResponse = {
                    "role": chatRagResponse.completion.choices[0].message.role,
                    "content": chatRagResponse.completion.choices[0].message.content
                }
            } else {
                throw new Error(`The model ${chatModelName} is not supported in this application.`);
            }

            // Store response and build payload
            const responseTimestamp = new Date().toISOString();
            await storeModelResponse(conversationId, responseTimestamp, chatCompletionResponse, Message, Conversation);

            const response = {
                "role": chatCompletionResponse.role,
                "content": chatCompletionResponse.content,
                "messageTime": responseTimestamp,
                "additionalContents": chatRagResponse.additionalContents,
            };

            return response;
        }
        catch (error) {
            console.error('Error while generating response for user query:', error);
            throw error;
        }
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

}