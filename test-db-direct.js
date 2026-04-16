const { Client } = require('pg');

async function testConnection() {
  const connectionString = "postgresql://crm_user:lustosa1125180124@69.62.93.186:45432/lexcrm?schema=public";
  const client = new Client({ connectionString });

  console.log(`Testando conexao direta com: 69.62.93.186:45432...`);
  
  try {
    await client.connect();
    console.log("✅ CONECTADO com sucesso ao Banco de Dados na VPS!");
    const res = await client.query('SELECT NOW()');
    console.log("Hora no servidor:", res.rows[0].now);
  } catch (err) {
    console.error("❌ FALHA na conexao direta:", err.message);
    console.error("Dica: Verifique se o IP 69.62.93.186 esta acessivel e a porta 45432 esta aberta.");
  } finally {
    await client.end();
  }
}

testConnection();
