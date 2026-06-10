import { promises as dns, Resolver } from 'dns';
import * as nodemailer from 'nodemailer';

/**
 * Onda 17.32.175/176 — Cria o transporter SMTP com resolucao de DNS
 * resiliente, em 3 camadas:
 *
 *   1. dns.lookup (getaddrinfo do SO) — caminho normal;
 *   2. consulta DIRETA a resolvers publicos (8.8.8.8 / 1.1.1.1) via
 *      dns.Resolver, ignorando o resolv.conf do container;
 *   3. fallback: entrega o hostname cru ao nodemailer.
 *
 * Motivo: no Swarm da VPS o DNS do container quebra com frequencia
 * (e redeploys do stack podem reverter o `dns:` configurado). O
 * nodemailer ainda por cima usa dns.resolve4/6 (c-ares direto no
 * resolv.conf), que falha mesmo quando getaddrinfo funciona. Aqui
 * resolvemos por conta propria e conectamos pelo IP, passando o
 * hostname original em tls.servername pro SNI/validacao de
 * certificado continuarem corretos (587 STARTTLS e 465 TLS).
 */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1'];

function resolveViaPublicDns(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolver = new Resolver({ timeout: 5000, tries: 2 });
    resolver.setServers(PUBLIC_DNS);
    resolver.resolve4(host, (err4, addrs4) => {
      if (!err4 && addrs4?.length) return resolve(addrs4[0]);
      resolver.resolve6(host, (err6, addrs6) => {
        if (!err6 && addrs6?.length) return resolve(addrs6[0]);
        reject(err6 || err4 || new Error('sem resposta dos resolvers publicos'));
      });
    });
  });
}

export async function createSmtpTransport(smtp: SmtpConfig) {
  let connectHost = smtp.host;
  let servername: string | undefined;

  try {
    const resolved = await dns.lookup(smtp.host);
    connectHost = resolved.address;
    servername = smtp.host;
  } catch {
    try {
      connectHost = await resolveViaPublicDns(smtp.host);
      servername = smtp.host;
    } catch {
      // ambos falharam — deixa o nodemailer tentar com o hostname
    }
  }

  return nodemailer.createTransport({
    host: connectHost,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    ...(servername ? { tls: { servername } } : {}),
  });
}
