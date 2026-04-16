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
      data: { where: {}, limit: 2000 }
    });
    const items = resp.data;
    const formats = {};
    items.forEach(i => {
      const suffix = i.remoteJid?.split('@')[1] || 'no-suffix';
      formats[suffix] = (formats[suffix] || 0) + 1;
    });
    console.log('JID Formats:', formats);
    
    const sampleUnsaved = items.filter(i => i.remoteJid?.includes('@s.whatsapp.net')).slice(0, 10);
    console.log('Sample JIDs (@s.whatsapp.net):');
    sampleUnsaved.forEach(i => console.log(` - ${i.remoteJid} (pushName: ${i.pushName}, number: ${i.number})`));

  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }
}

test();
