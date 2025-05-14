/* Main implementation file for handling chat */

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const cds = require('@sap/cds');
const { DELETE, UPDATE, SELECT } = cds.ql;
const { storeRetrieveMessages, storeModelResponse } = require('./memory-helper');
const xml2js = require('xml2js');

const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

const systemPrompt = `You are a helpful assistant who answers user questions based on the following context enclosed in triple quotes. If the context doesn't contain relevant information to answer the question, you can help with your general knowledge, start your response with "I couldn't find any relevant information in the provided documents. Based on my general knowledge:" to make it clear to the user that you're using information outside of the provided context.\n`;

// --- Dynamic OData Metadata Fetching ---
let odataMetadataCache = null;
let odataEntityMap = null;

async function fetchODataMetadata(serviceUrl) {
    const username = process.env.ODATA_API_USERNAME;
    const password = process.env.ODATA_API_PASSWORD;
    const response = await axios.get(`${serviceUrl}/$metadata`, {
        auth: { username, password },
        headers: { 'Accept': 'application/xml' },
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    const xml = response.data;
    const parser = new xml2js.Parser();
    const metadata = await parser.parseStringPromise(xml);
    return metadata;
}

function buildEntityMap(metadata) {
    // This function builds a map: { EntitySetName: { properties: { ... }, ... } }
    const schema = metadata['edmx:Edmx']['edmx:DataServices'][0].Schema.find(s => s.EntityType);
    const entityTypes = schema.EntityType;
    const entitySets = schema.EntityContainer[0].EntitySet;
    const entityMap = {};
    for (const set of entitySets) {
        const setName = set.$.Name;
        const typeName = set.$.EntityType.split('.').pop();
        const entityType = entityTypes.find(e => e.$.Name === typeName);
        if (entityType) {
            const properties = {};
            for (const prop of entityType.Property) {
                properties[prop.$.Name] = {
                    type: prop.$.Type,
                    maxLength: prop.$.MaxLength,
                    label: prop.$['sap:label'] || prop.$.Name
                };
            }
            entityMap[setName] = {
                typeName,
                properties
            };
        }
    }
    return entityMap;
}

async function getODataEntityMap(serviceUrl) {
    if (!odataEntityMap) {
        if (!odataMetadataCache) {
            odataMetadataCache = await fetchODataMetadata(serviceUrl);
        }
        odataEntityMap = buildEntityMap(odataMetadataCache);
    }
    return odataEntityMap;
}

// --- Dynamic Entity Extraction using OData Metadata ---

async function extractEntitiesWithDynamicMetadata(user_query, capllmplugin, entityMap) {
    const prompt = `Extract the most relevant entity set, intent, and properties from the user's question based on the following OData metadata. 
If a property is not present, return null for that property.

Available entity sets and their properties:
${JSON.stringify(entityMap, null, 2)}

Respond ONLY with a valid JSON object containing:
1. entitySet: The most likely entity set
2. intent: The most likely intent (e.g., Get, List, Find, Details, etc.)
3. properties: An object containing the extracted property values

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
            max_tokens: 200,
            temperature: 0
        }
    );
    const raw = completion.choices[0].message.content;

    try {
        const match = raw.match(/{[\s\S]*}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            return parsed;
        }
        return { entitySet: null, intent: 'Unknown', properties: {} };
    } catch (err) {
        console.error(`Error parsing JSON: ${err}`);
        return { entitySet: null, intent: 'Unknown', properties: {} };
    }
}

// --- Dynamic Handler for Entity Queries ---
async function handleDynamicEntityQuery(entitySet, intent, properties, entityMap) {
    // Example: Only basic GET/List supported for now
    if (!entitySet || !entityMap[entitySet]) throw new Error('Unknown entity set');
    const entityInfo = entityMap[entitySet];
    // Build OData filter string from properties
    const filters = Object.entries(properties)
        .filter(([k, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `substringof('${v}', ${k})`)
        .join(' and ');
    const baseUrl = `https://172.16.0.64:8443/sap/opu/odata/sap/API_${entitySet.toUpperCase()}/${entitySet}`;
    const url = filters ? `${baseUrl}?$filter=${filters}&$format=json` : `${baseUrl}?$format=json`;
    console.log('[DEBUG] OData Query URL:', url);
    console.log('[DEBUG] OData Filters:', filters);
    const username = process.env.ODATA_API_USERNAME;
    const password = process.env.ODATA_API_PASSWORD;
    try {
        const response = await axios.get(url, {
            auth: { username, password },
            headers: { 'Accept': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        const results = response.data?.d?.results;
        console.log('[DEBUG] OData Results:', results);
        if (results && results.length > 0) {
            const entry = results[0];
            // Try to find which property the user is asking for
            const requestedProperty = Object.keys(properties).find(
                key => properties[key] === null && entry[key] !== undefined && typeof entry[key] === 'string' && entry[key]
            );
            if (requestedProperty) {
                // Use the label from metadata if available, otherwise the property name
                const label = (entityInfo.properties[requestedProperty] && entityInfo.properties[requestedProperty].label) || requestedProperty;
                // Try to show the context (other provided properties)
                const contextFields = Object.entries(properties)
                    .filter(([k, v]) => v && k !== requestedProperty)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                return `The ${label}${contextFields ? ` for ${contextFields}` : ''} is ${entry[requestedProperty]}.`;
            }
            // If only one result, show up to 5 most relevant fields
            if (results.length === 1) {
                const fields = Object.entries(entry)
                    .filter(([k, v]) => typeof v === 'string' && v && !k.startsWith('__'))
                    .slice(0, 5)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n');
                return `Here is what I found:\n${fields}`;
            }
            // If multiple results, show a short list (e.g., name + key)
            const preview = results.slice(0, 5).map(entry => {
                const name = entry.EquipmentName || entry.Name || entry.Description || '';
                const key = entry.Equipment || entry.ID || entry.id || '';
                return `${name} (${key})`;
            }).join('\n');
            return `Found ${results.length} result(s) in ${entitySet}:\n${preview}`;
        }
        return `No data found in ${entitySet} for the given criteria.`;
    } catch (error) {
        console.error('[DEBUG] OData Error:', error.message);
        return `Error fetching data: ${error.message}`;
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
            
            // Save order number to context if present in user query
            const orderMatch = user_query.match(/order\s*(\d+)/i);
            if (orderMatch) {
                const orderId = orderMatch[1];
                await UPDATE(Conversation).set({ lastOrderNumber: orderId }).where({ cID: conversationId });
            }
            
            console.log('user_query:', user_query);
            console.log('Connecting to CAP LLM plugin...');
            const capllmplugin = await cds.connect.to("cap-llm-plugin");
            
            // --- Entity extraction using metadata ---
            const entityMap = await getODataEntityMap("https://172.16.0.64:8443/sap/opu/odata/sap/API_EQUIPMENT");
            const { entitySet, intent, properties } = await extractEntitiesWithDynamicMetadata(user_query, capllmplugin, entityMap);
            const chatModelName = "gpt-4";
            
            // Always store the user message and retrieve memory context
            const memoryContext = await storeRetrieveMessages(conversationId, messageId, message_time, user_id, user_query, Conversation, Message, chatModelName);
            let responseText = '';
            let additionalContents = null;

            // Try to handle the query using entity metadata
            try {
                if (intent !== 'Unknown') {
                    responseText = await handleDynamicEntityQuery(entitySet, intent, properties, entityMap);
                }

                // Check if we got a valid response or if it contains error messages
                if (!responseText || responseText.includes('Error fetching data') || responseText.includes('No data found')) {
                    throw new Error('No specific data found');
                }
            } catch (error) {
                console.log('[DEBUG] Fallback to general knowledge due to:', error.message);
                // Fallback to LLM/RAG logic with general knowledge
                const embeddingModelName = "text-embedding-ada-002";
                const chatModelConfig = cds.env.requires["gen-ai-hub"][chatModelName];
                const embeddingModelConfig = cds.env.requires["gen-ai-hub"][embeddingModelName];

                // --- Existing RAG logic ---
                const chatRagResponse = await capllmplugin.getRagResponseWithConfig(
                    user_query,
                    tableName,
                    embeddingColumn,
                    contentColumn,
                    systemPrompt,
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