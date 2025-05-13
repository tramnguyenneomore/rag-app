/* Main implementation file for handling chat */

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const cds = require('@sap/cds');
const { DELETE, UPDATE, SELECT } = cds.ql;
const { storeRetrieveMessages, storeModelResponse } = require('./memory-helper');

const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

const systemPrompt = `You are a helpful assistant who answers user questions based on the following context enclosed in triple quotes. If the context doesn't contain relevant information to answer the question, you can help with your general knowledge, start your response with "I couldn't find any relevant information in the provided documents. Based on my general knowledge:" to make it clear to the user that you're using information outside of the provided context.\n`;
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

// --- Entity Extraction with GPT-4 ---
async function extractEntitiesWithGPT4(user_query, capllmplugin) {
    const prompt = `Extract the following entities and intent from the user's question. 
If an entity is not present, return null for that entity.

Entities to extract:
- intent (e.g., GetEquipmentNumber, GetManufacturerInfo, ListEquipmentByPlant)
- equipment_name
- equipment_id
- maintenance_plant
- subentity (e.g., serial_number, manufacturer_name)

Respond ONLY with a valid JSON object and nothing else.

User question: "${user_query}"
JSON:`;

    const chatConfig = cds.env.requires["gen-ai-hub"]["gpt-4"];
    const completion = await capllmplugin.getChatCompletionWithConfig(
        chatConfig,
        {
            messages: [
                { role: "system", content: "You are an expert at extracting structured data from user questions." },
                { role: "user", content: prompt }
            ],
            max_tokens: 150,
            temperature: 0
        }
    );
    const raw = completion.choices[0].message.content;

    try {
        // Extract the first {...} block using regex
        const match = raw.match(/{[\s\S]*}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            return parsed;
        }
        return { intent: 'Unknown' };
    } catch (err) {
        console.error(`Error parsing JSON: ${err}`);
        return { intent: 'Unknown' };
    }
}

// --- Generic OData Query Function ---
async function queryEquipmentOData({ filter, single, extractField, formatList }) {
    const baseUrl = "https://172.16.0.64:8443/sap/opu/odata/sap/API_EQUIPMENT/Equipment";
    const url = single
        ? `${baseUrl}(${filter})?$format=json`
        : `${baseUrl}?$filter=${filter}&$format=json`;
    const username = process.env.ODATA_API_USERNAME;
    const password = process.env.ODATA_API_PASSWORD;
    try {
        const response = await axios.get(url, {
            auth: { username, password },
            headers: { 'Accept': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        if (single) {
            const data = response.data?.d;
            if (data && extractField) {
                return extractField(data);
            }
            return "No data found.";
        } else {
            const results = response.data?.d?.results;
            if (results && results.length > 0) {
                return formatList ? formatList(results) : JSON.stringify(results);
            }
            return "No data found.";
        }
    } catch (error) {
        return `Error fetching data: ${error.message}`;
    }
}

// --- Refactored Handlers ---
async function handleGetEquipmentNumber(equipment_name) {
    return await queryEquipmentOData({
        filter: `substringof('${equipment_name}', EquipmentName)`,
        single: false,
        formatList: results => `The equipment number for ${equipment_name} is ${results[0].Equipment}.`
    });
}

// --- Handler for Manufacturer Info (Name or Serial Number) ---
async function handleGetManufacturerInfo(equipment_id, subentity) {
    return await queryEquipmentOData({
        filter: `Equipment='${equipment_id}',ValidityEndDate=datetime'9999-12-31T00:00:00'`,
        single: true,
        extractField: data => {
            if (subentity === 'serial_number') {
                return data.ManufacturerSerialNumber
                    ? `The manufacturer's serial number for equipment ${equipment_id} is ${data.ManufacturerSerialNumber}.`
                    : `No manufacturer's serial number found for equipment ${equipment_id}.`;
            }
            // Default: manufacturer name
            return data.AssetManufacturerName
                ? `The manufacturer of equipment ${equipment_id} is ${data.AssetManufacturerName}.`
                : `No manufacturer found for equipment ${equipment_id}.`;
        }
    });
}

async function handleListEquipmentByPlant(maintenance_plant) {
    return await queryEquipmentOData({
        filter: `MaintenancePlant eq '${encodeURIComponent(maintenance_plant)}'`,
        single: false,
        formatList: results => {
            const equipmentList = results.map(eq => `${eq.Equipment} (${eq.EquipmentName})`).join(', ');
            return `Equipment in maintenance plant ${maintenance_plant}: ${equipmentList}`;
        }
    });
}

module.exports = function () {
    this.on('getChatRagResponse', async (req) => {
        try {
            console.log('=== Starting getChatRagResponse ===');
            const { conversationId, messageId, message_time, user_id, user_query } = req.data;
            const { Conversation, Message } = this.entities;
            
            console.log('Connecting to CAP LLM plugin...');
            const capllmplugin = await cds.connect.to("cap-llm-plugin");
            
            // --- Entity extraction using GPT-4 ---
            const { intent, equipment_name, equipment_id, maintenance_plant, subentity } = await extractEntitiesWithGPT4(user_query, capllmplugin);
            const chatModelName = "gpt-4";
            
            // Always store the user message and retrieve memory context
            const memoryContext = await storeRetrieveMessages(conversationId, messageId, message_time, user_id, user_query, Conversation, Message, chatModelName);
            let responseText = '';
            let additionalContents = null;

            // Try to get specific information first
            try {
                if (intent === 'GetEquipmentNumber' && equipment_name) {
                    responseText = await handleGetEquipmentNumber(equipment_name);
                } else if (intent === 'GetManufacturerInfo' && equipment_id) {
                    responseText = await handleGetManufacturerInfo(equipment_id, subentity);
                } else if (intent === 'ListEquipmentByPlant' && maintenance_plant) {
                    responseText = await handleListEquipmentByPlant(maintenance_plant);
                }

                // Check if we got a valid response or if it contains error messages
                if (!responseText || responseText.includes('Error fetching data') || responseText.includes('No data found')) {
                    throw new Error('No specific data found');
                }
            } catch (error) {
                console.log('Falling back to general knowledge due to:', error.message);
                // Fallback to LLM/RAG logic with general knowledge
                const embeddingModelName = "text-embedding-ada-002";
                const chatModelConfig = cds.env.requires["gen-ai-hub"][chatModelName];
                const embeddingModelConfig = cds.env.requires["gen-ai-hub"][embeddingModelName];

                // --- OData API Integration ---
                const orderMatch = user_query.match(/order\s*(\d+)/i);
                let orderId;
                if (orderMatch) {
                    orderId = orderMatch[1];
                    await UPDATE(Conversation).set({ lastOrderNumber: orderId }).where({ cID: conversationId });
                } else {
                    const convo = await SELECT.one.from(Conversation).where({ cID: conversationId });
                    orderId = convo?.lastOrderNumber;
                }

                let orderContext = '';
                if (orderId) {
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
                    systemPromptWithOrder,
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
                responseText = chatCompletionResponse.content;
                additionalContents = chatRagResponse.additionalContents;
            }

            // Always store the assistant's response
            const responseTimestamp = new Date().toISOString();
            const chatCompletionResponse = { role: 'assistant', content: responseText };
            await storeModelResponse(conversationId, responseTimestamp, chatCompletionResponse, Message, Conversation);

            return {
                role: 'assistant',
                content: responseText,
                messageTime: responseTimestamp,
                additionalContents: additionalContents
            };
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

    // Add handler for READ operation
    this.on('READ', 'Conversation', async (req) => {
        return await SELECT.from(this.entities.Conversation);
    });
}