const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';

async function test() {
  const ep = { name: 'POST findChats (limit 2000)', method: 'POST', path: `chat/findChats/${INSTANCE}`, data: { where: {}, limit: 2000 } };

  console.log(`--- Testing ${ep.name} ---`);
  try {
    const resp = await axios({
      method: ep.method,
      url: `${URL}/${ep.path}`,
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      data: ep.data
    });
    const data = resp.data;
    const count = Array.isArray(data) ? data.length : (data.data ? data.data.length : 'unknown');
    console.log(`Success! Result count: ${count}`);
    if (count > 0) {
      const items = Array.isArray(data) ? data : data.data;
      console.log('First 5 remoteJids:');
      items.slice(0, 5).forEach(i => console.log(` - ${i.remoteJid} (pushName: ${i.pushName})`));
    }
  } catch (e) {
    console.log(`Failed: ${e.message} ${e.response?.status} ${JSON.stringify(e.response?.data)}`);
  }
}

test();
