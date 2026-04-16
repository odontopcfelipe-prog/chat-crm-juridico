const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';

async function test() {
  try {
    const resp = await axios({
      method: 'POST',
      url: `${URL}/chat/findChats/${INSTANCE}`,
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      data: { where: {}, limit: 1 }
    });
    console.log('Full Chat Entry:', JSON.stringify(resp.data[0], null, 2));
  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }
}

test();
