import { promises as dns } from 'dns';
import * as nodemailer from 'nodemailer';

/**
 * Onda 17.32.175 — Cria o transporter SMTP resolvendo o hostname
 * via dns.lookup (getaddrinfo do SO) ANTES de entregar ao nodemailer.
 *
 * Motivo: dentro do Swarm da VPS, o resolvedor do sistema funciona
 * (getent/net.connect ok), mas o nodemailer resolve hostnames com
 * dns.resolve4/6 (c-ares direto no resolv.conf), que falha com
 * ENOTFOUND mesmo com `dns: 8.8.8.8` no servico. Conectamos pelo IP
 * e passamos o hostname original em tls.servername pro SNI/validacao
 * de certificado continuarem corretos (STARTTLS na 587 e TLS na 465).
 */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export async function createSmtpTransport(smtp: SmtpConfig) {
  let connectHost = smtp.host;
  let servername: string | undefined;
  try {
    const resolved = await dns.lookup(smtp.host);
    connectHost = resolved.address;
    servername = smtp.host;
  } catch {
    // lookup falhou — deixa o nodemailer tentar com o hostname mesmo
  }

  return nodemailer.createTransport({
    host: connectHost,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    ...(servername ? { tls: { servername } } : {}),
  });
}
