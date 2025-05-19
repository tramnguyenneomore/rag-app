/* Main implementation file for handling chat */

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const cds = require('@sap/cds');
const { DELETE, UPDATE, SELECT } = cds.ql;
const { storeRetrieveMessages, storeModelResponse } = require('./memory-helper');
const xml2js = require('xml2js');

// Constants and configurations
const API_SERVICES = {
    EQUIPMENT: {
        baseUrl: 'https://172.16.0.64:8443/sap/opu/odata/sap/API_EQUIPMENT',
        name: 'Equipment',
        keywords: ['equipment', 'machine', 'device', 'asset', 'manufacturer', 'model', 'serial number']
    },
    MAINTENANCE: {
        baseUrl: 'https://172.16.0.64:8443/sap/opu/odata/sap/API_MAINTNOTIFICATION',
        name: 'Maintenance Notification',
        keywords: ['maintenance', 'notification', 'repair', 'service', 'issue', 'problem', 'fault']
    }
};

const CHAT_CONFIG = {
    modelName: "gpt-4",
    embeddingModelName: "text-embedding-ada-002",
    tableName: 'SAP_TISCE_DEMO_DOCUMENTCHUNK',
    embeddingColumn: 'EMBEDDING',
    contentColumn: 'TEXT_CHUNK'
};

const systemPrompt = `You are a helpful assistant who answers user questions based on the provided context. Always respond in the same language as the user's question. If the context doesn't contain relevant information, you can use your general knowledge, but make it clear to the user that you're using information outside of the provided context.\n`;

// --- Dynamic OData Metadata Fetching ---
let odataMetadataCache = {};
let odataEntityMap = {};

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
    // Use service URL as cache key
    const cacheKey = serviceUrl;
    console.log('[DEBUG] Getting entity map for service:', cacheKey);

    if (!odataEntityMap[cacheKey]) {
        if (!odataMetadataCache[cacheKey]) {
            console.log('[DEBUG] Fetching metadata for service:', cacheKey);
            odataMetadataCache[cacheKey] = await fetchODataMetadata(serviceUrl);
        }
        odataEntityMap[cacheKey] = buildEntityMap(odataMetadataCache[cacheKey]);
        console.log('[DEBUG] Built entity map for service:', cacheKey);
        console.log('[DEBUG] Available entity sets:', Object.keys(odataEntityMap[cacheKey]));
    }
    return odataEntityMap[cacheKey];
}

// --- Dynamic Entity Extraction using OData Metadata ---

async function extractEntitiesWithDynamicMetadata(user_query, llmPlugin, entityMap) {
    console.log('[DEBUG] Extracting entities for query:', user_query);
    console.log('[DEBUG] Available entity sets:', Object.keys(entityMap));

    // Build property rules from metadata
    const propertyRules = Object.entries(entityMap).map(([entitySet, info]) => {
        const properties = Object.entries(info.properties).map(([propName, propInfo]) => {
            const label = propInfo.label || propName;
            const type = propInfo.type;
            let rule = `- ${propName} (${label}): `;

            // Add type-specific rules
            if (type.includes('String')) {
                rule += 'Use for text descriptions and names';
            } else if (type.includes('Number') || type.includes('Int')) {
                rule += 'Use for numeric identifiers and quantities';
            } else if (type.includes('DateTime')) {
                rule += 'Use for dates and timestamps';
            } else if (type.includes('Boolean')) {
                rule += 'Use for yes/no conditions';
            }

            return rule;
        }).join('\n');

        return `${entitySet}:\n${properties}`;
    }).join('\n\n');

    const prompt = `Extract the most relevant entity set, intent, and properties from the user's question based on the following OData metadata. 
If a property is not present, return null for that property.

Available entity sets and their properties:
${JSON.stringify(entityMap, null, 2)}

Property Rules:
${propertyRules}

Respond ONLY with a valid JSON object containing:
1. entitySet: The most likely entity set (e.g., "Equipment" for equipment queries, "MaintenanceNotification" for notification queries)
2. intent: The most likely intent (e.g., Get, List, Find, Details, etc.)
3. properties: An object containing the extracted property values

IMPORTANT RULES:
1. The entitySet name MUST match exactly one of these available entity sets: ${Object.keys(entityMap).join(', ')}
2. Use ONLY properties that exist in the metadata for the selected entity set
3. Pay attention to property types and labels when matching user input
4. If multiple properties could match, prefer the one that best fits the context
5. For maintenance notifications:
   - Use NotificationText for issue descriptions
   - Use TechnicalObjectDescription for equipment descriptions
   - Use Notification for notification numbers

User question: "${user_query}"
JSON:`;

    const chatConfig = cds.env.requires["gen-ai-hub"]["gpt-4"];
    const completion = await llmPlugin.getChatCompletionWithConfig(
        chatConfig,
        {
            messages: [
                { role: "system", content: "You are an expert at extracting structured data from user questions. Use the provided metadata and property rules to accurately extract entities and their properties. Only use properties that exist in the metadata." },
                { role: "user", content: prompt }
            ],
            max_tokens: 200,
            temperature: 0
        }
    );
    const raw = completion.choices[0].message.content;
    console.log('[DEBUG] Raw entity extraction response:', raw);

    try {
        const match = raw.match(/{[\s\S]*}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            console.log('[DEBUG] Parsed entity extraction:', parsed);
            console.log('[DEBUG] Checking if entitySet exists in map:', parsed.entitySet, 'Available sets:', Object.keys(entityMap));

            // Validate entity set exists
            if (!entityMap[parsed.entitySet]) {
                console.log('[DEBUG] Entity set not found in map. Available sets:', Object.keys(entityMap));
                // Try to find a matching entity set
                const matchingSet = Object.keys(entityMap).find(set =>
                    set.toLowerCase().includes(parsed.entitySet.toLowerCase()) ||
                    parsed.entitySet.toLowerCase().includes(set.toLowerCase())
                );
                if (matchingSet) {
                    console.log('[DEBUG] Found matching entity set:', matchingSet);
                    parsed.entitySet = matchingSet;
                }
            }

            // Validate properties exist in the metadata
            if (parsed.entitySet && entityMap[parsed.entitySet]) {
                const validProperties = {};
                for (const [key, value] of Object.entries(parsed.properties)) {
                    if (entityMap[parsed.entitySet].properties[key]) {
                        validProperties[key] = value;
                    } else {
                        console.log(`[DEBUG] Property ${key} not found in metadata for ${parsed.entitySet}`);
                    }
                }
                parsed.properties = validProperties;
            }

            return parsed;
        }
        console.log('[DEBUG] No valid JSON found in response');
        return { entitySet: null, intent: 'Unknown', properties: {} };
    } catch (err) {
        console.error(`Error parsing JSON: ${err}`);
        return { entitySet: null, intent: 'Unknown', properties: {} };
    }
}

// --- Dynamic Handler for Entity Queries ---
async function handleDynamicEntityQuery(entitySet, intent, properties, entityMap, service) {
    if (!entitySet || !entityMap[entitySet]) throw new Error('Unknown entity set');
    const entityInfo = entityMap[entitySet];
    
    // Build OData filter string from properties
    const filters = Object.entries(properties)
        .filter(([k, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `substringof('${v}', ${k})`)
        .join(' and ');
    
    const baseUrl = `${service.baseUrl}/${entitySet}`;
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
            
            // Format the response in a simple, readable way
            const relevantFields = Object.entries(entry)
                .filter(([k, v]) => typeof v === 'string' && v && !k.startsWith('__'))
                .map(([k, v]) => {
                    const label = (entityInfo.properties[k] && entityInfo.properties[k].label) || k;
                    return `${label}: ${v}`;
                })
                .join('\n');

            return relevantFields;
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

// Helper functions
async function getServiceConfig(capllmplugin, userQuery) {
    console.log('[DEBUG] Determining service for query:', userQuery);
    const prompt = `Analyze the following user query and determine which API service it's most likely related to.
Available services:
${Object.entries(API_SERVICES).map(([key, service]) =>
    `${service.name} (${key}): Keywords - ${service.keywords.join(', ')}`
).join('\n')}

User query: "${userQuery}"

Respond with ONLY the service key (EQUIPMENT or MAINTENANCE) that best matches the query.`;

    const chatConfig = cds.env.requires["gen-ai-hub"][CHAT_CONFIG.modelName];
    const completion = await capllmplugin.getChatCompletionWithConfig(
        chatConfig,
        {
            messages: [
                { role: "system", content: "You are an expert at determining which service a user query belongs to." },
                { role: "user", content: prompt }
            ],
            max_tokens: 50,
            temperature: 0
        }
    );

    const serviceKey = completion.choices[0].message.content.trim();
    console.log('[DEBUG] Service key:', serviceKey);
    return API_SERVICES[serviceKey];
}

async function processChatQuery(req, capllmplugin, srv) {
    const { conversationId, messageId, message_time, user_id, user_query } = req.data;
    let responseText = '';
    let apiResponse = '';
    let hasValidApiResponse = false;

    try {
        console.log('[DEBUG] Processing query:', user_query);

        // Get memory context first
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

        // Try API first if applicable
        const service = await getServiceConfig(capllmplugin, user_query);
        if (service) {
            try {
                const entityMap = await getODataEntityMap(service.baseUrl);
                const { entitySet, intent, properties } = await extractEntitiesWithDynamicMetadata(
                    user_query,
                    capllmplugin,
                    entityMap
                );

                if (entitySet && intent !== 'Unknown') {
                    apiResponse = await handleDynamicEntityQuery(entitySet, intent, properties, entityMap, service);
                    if (apiResponse && !apiResponse.includes('No data found') && !apiResponse.includes('Error fetching data')) {
                        hasValidApiResponse = true;
                    } else {
                        // If OData returns no data, set apiResponse to empty to ensure RAG response is used
                        apiResponse = '';
                    }
                }
            } catch (error) {
                console.error('Error in API processing:', error.message);
            }
        }

        // Get RAG response
        const ragPrompt = `Based on the following context and user query, provide a direct, human-friendly response.
IMPORTANT: You MUST respond in the EXACT SAME LANGUAGE as the user's query, even if the context is in a different language. If the context is in another language, translate it to match the user's query language.

User Query: "${user_query}"
${apiResponse ? `API Response: "${apiResponse}"` : ''}

If the API response indicates no data was found, please provide a helpful response based on the available context and general knowledge. Make it clear if you're using information outside of the provided context.`;

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