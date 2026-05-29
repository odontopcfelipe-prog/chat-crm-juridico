import type { NextConfig } from "next";
import path from "path";

const backendUrl = process.env.INTERNAL_API_URL || "http://api:3000";
// O socket.io NAO fica sob /api (em prod o Traefik tem router proprio pra /socket.io).
// No dev local o INTERNAL_API_URL inclui /api, entao removemos esse sufixo SO pro
// socket — senao o proxy aponta pra /api/socket.io (inexistente) e o socket entra
// em loop de reconexao/erro. Em prod (INTERNAL_API_URL sem /api) isto e no-op.
const backendOrigin = backendUrl.replace(/\/api\/?$/, "");

// Domínios Google necessários para GTM, Google Ads e Analytics
const googleScriptSrc = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://ssl.google-analytics.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
  "https://www.google.com",
  "https://connect.facebook.net",   // Meta Pixel (se utilizado)
].join(" ");

const googleConnectSrc = [
  "https://www.google-analytics.com",
  "https://analytics.google.com",
  "https://stats.g.doubleclick.net",
  "https://www.googletagmanager.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
].join(" ");

const googleFrameSrc = [
  "https://www.googletagmanager.com",
  "https://td.doubleclick.net",
  "https://www.google.com",
].join(" ");

const securityHeaders = [
  {
    key: "X-DNS-Prefetch-Control",
    value: "on",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // Permite scripts do Google Tag Manager e Google Ads
    key: "Content-Security-Policy",
    value: [
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${googleScriptSrc}`,
      `img-src 'self' data: blob: https: http:`,
      `connect-src 'self' https: wss: ${googleConnectSrc}`,
      `frame-src 'self' ${googleFrameSrc}`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src 'self' data: https://fonts.gstatic.com`,
      `media-src 'self' https: blob:`,
      `worker-src 'self' blob:`,
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Nao redirecionar barra final: o socket.io usa o path "/socket.io/" e, sem isto,
  // o Next responde 308 antes do rewrite — o socket nao conecta no dev. Em prod o
  // socket vai pelo Traefik (nao por este rewrite), entao isto e inocuo la.
  skipTrailingSlashRedirect: true,
  // Necessário em monorepo: garante que server.js fique em apps/web/server.js
  // dentro do standalone, que é o path que o Dockerfile espera no CMD.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  async headers() {
    return [
      {
        // Aplica os headers em todas as rotas
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/:path*`,
      },
      // Proxy Socket.IO (polling + WebSocket upgrade) para o NestJS.
      // O CF Tunnel roteia tudo para o Next.js; sem este rewrite /socket.io
      // retorna 404 e mensagens em tempo real não funcionam.
      {
        source: "/socket.io",
        destination: `${backendOrigin}/socket.io`,
      },
      {
        source: "/socket.io/:path*",
        destination: `${backendOrigin}/socket.io/:path*`,
      },
    ];
  },
};

export default nextConfig;
