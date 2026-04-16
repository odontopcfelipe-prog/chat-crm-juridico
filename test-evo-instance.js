const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';

async function test() {
  try {
    const resp = await axios({
      method: 'GET',
      url: `${URL}/instance/fetchInstances?instanceName=${INSTANCE}`,
      headers: { apikey: KEY }
    });
    console.log('Instance Data:', JSON.stringify(resp.data, null, 2));
  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }
}

test();
