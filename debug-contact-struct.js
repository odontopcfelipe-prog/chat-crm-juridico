const axios = require('axios');

async function debug() {
    const instance = 'whatsapp';
    const apiUrl = 'http://api.andrelustosaadvogados.com.br';
    const apiKey = '19a05742b587ef8e3e042d3ebe4197ae';

    console.log(`Probing contacts for instance: ${instance}`);
    try {
        const response = await axios.post(`${apiUrl}/chat/findContacts/${instance}`, {}, {
            headers: { 'apikey': apiKey }
        });

        const contacts = response.data;
        if (Array.isArray(contacts) && contacts.length > 0) {
            console.log('--- SAMPLE CONTACT ---');
            console.log(JSON.stringify(contacts[0], null, 2));
            
            console.log('\n--- FIELDS IN FIRST 5 CONTACTS ---');
            contacts.slice(0, 5).forEach((c, i) => {
                console.log(`Contact ${i}: id=${c.id}, remoteJid=${c.remoteJid}, pushName=${c.pushName}, name=${c.name}, number=${c.number}`);
            });
        } else {
            console.log('No contacts found or invalid response format:', contacts);
        }
    } catch (error) {
        console.error('Error fetching contacts:', error.response ? error.response.status : error.message);
        if (error.response) console.error(JSON.stringify(error.response.data, null, 2));
    }
}

debug();
