const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';

async function test() {
  const whereVariations = [
    { archived: true },
    { archived: false },
    { isGroup: true },
    { isGroup: false },
    {}
  ];

  for (const w of whereVariations) {
    console.log(`--- Testing findChats with where: ${JSON.stringify(w)} ---`);
    try {
      const resp = await axios({
        method: 'POST',
        url: `${URL}/chat/findChats/${INSTANCE}`,
        headers: { apikey: KEY, 'Content-Type': 'application/json' },
        data: { where: w, limit: 1000 }
      });
      const data = resp.data;
      const count = Array.isArray(data) ? data.length : (data.data ? data.data.length : 'unknown');
      console.log(`Result count: ${count}`);
    } catch (e) {
      console.log(`Failed: ${e.message}`);
    }
  }
}

test();
