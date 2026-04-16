import { Metadata } from 'next';
import { MessageCircle, Phone, Mail, MapPin, Clock, Instagram, Facebook } from 'lucide-react';
import localFont from 'next/font/local';
import { Playfair_Display } from 'next/font/google';

export const metadata: Metadata = {
  title: 'Portal do Cliente | André Lustosa Advogados',
  description: 'Área do cliente André Lustosa Advogados. Entre em contato para acompanhar seu processo.',
  robots: { index: false, follow: false },
};

const neueMontreal = localFont({
  src: [
    { path: '../../../public/fonts/NeueMontreal-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../../../public/fonts/NeueMontreal-Medium.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-neue-montreal',
  display: 'swap',
});

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
});

const WHATSAPP = 'https://wa.me/5582996390799';
const PHONE = '82 99639-0799';
const EMAIL = 'contato@andrelustosa.com.br';
const ADDRESS = 'Rua Francisco Rodrigues Viana, 244, Baixa Grande, Arapiraca - AL';

export default function PortalPage() {
  return (
    <div className={`${neueMontreal.variable} ${playfair.variable} font-sans min-h-screen bg-[#0a0a0f] text-white flex flex-col`}>

      {/* Header */}
      <header className="border-b border-white/10 bg-[#0d0d14]/80 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/landing/logo_andre_lustosa_transparente.png"
              alt="André Lustosa Advogados"
              className="h-8 w-auto"
            />
            <div className="hidden sm:block w-px h-6 bg-white/20" />
            <span className="hidden sm:block text-xs font-bold text-[#A89048] uppercase tracking-widest">
              Portal do Cliente
            </span>
          </div>
          <a
            href={WHATSAPP}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 transition-colors text-white text-xs font-bold px-4 py-2 rounded-full"
          >
            <MessageCircle size={14} />
            Falar no WhatsApp
          </a>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="max-w-2xl w-full text-center space-y-6">

          {/* Badge */}
          <span className="inline-block text-[10px] font-bold uppercase tracking-[0.2em] text-[#A89048] border border-[#A89048]/30 px-4 py-1.5 rounded-full">
            Área do Cliente
          </span>

          {/* Title */}
          <h1 className="font-[family-name:var(--font-playfair)] text-3xl sm:text-4xl font-bold text-white leading-tight">
            Acompanhe seu processo<br />
            <span className="text-[#A89048]">com quem você confia</span>
          </h1>

          <p className="text-slate-400 text-sm leading-relaxed max-w-md mx-auto">
            O portal online está em desenvolvimento. Por enquanto, entre em contato
            diretamente conosco para acompanhar o andamento do seu caso.
          </p>

          {/* CTA principal */}
          <a
            href={WHATSAPP}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 bg-emerald-600 hover:bg-emerald-500 transition-all text-white font-bold px-8 py-4 rounded-xl text-sm shadow-[0_8px_30px_rgba(16,185,129,0.25)] hover:shadow-[0_8px_40px_rgba(16,185,129,0.4)] hover:scale-[1.02] active:scale-[0.98]"
          >
            <MessageCircle size={18} />
            Falar com o Escritório
          </a>
        </div>

        {/* Cards de contato */}
        <div className="max-w-2xl w-full mt-16 grid grid-cols-1 sm:grid-cols-2 gap-4">

          <a
            href={`tel:+55${PHONE.replace(/\D/g, '')}`}
            className="group flex items-start gap-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#A89048]/40 rounded-2xl p-5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-[#A89048]/10 text-[#A89048] flex items-center justify-center shrink-0 group-hover:bg-[#A89048]/20 transition-colors">
              <Phone size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Telefone</p>
              <p className="text-sm font-semibold text-white">{PHONE}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Ligue ou envie mensagem</p>
            </div>
          </a>

          <a
            href={`mailto:${EMAIL}`}
            className="group flex items-start gap-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#A89048]/40 rounded-2xl p-5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-[#A89048]/10 text-[#A89048] flex items-center justify-center shrink-0 group-hover:bg-[#A89048]/20 transition-colors">
              <Mail size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">E-mail</p>
              <p className="text-sm font-semibold text-white">{EMAIL}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Resposta em até 24h</p>
            </div>
          </a>

          <div className="flex items-start gap-4 bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="w-10 h-10 rounded-xl bg-[#A89048]/10 text-[#A89048] flex items-center justify-center shrink-0">
              <MapPin size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Endereço</p>
              <p className="text-sm font-semibold text-white leading-snug">{ADDRESS}</p>
            </div>
          </div>

          <div className="flex items-start gap-4 bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="w-10 h-10 rounded-xl bg-[#A89048]/10 text-[#A89048] flex items-center justify-center shrink-0">
              <Clock size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Horário</p>
              <p className="text-sm font-semibold text-white">Seg–Sex, 8h às 18h</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Urgências: 24 horas</p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 py-6 px-6">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[11px] text-slate-600">
            © {new Date().getFullYear()} André Lustosa Advogados. OAB/AL.
          </p>
          <div className="flex items-center gap-3">
            <a href="https://www.instagram.com/andrelustosaadvogados/" target="_blank" rel="noopener noreferrer" className="text-slate-600 hover:text-[#A89048] transition-colors">
              <Instagram size={16} />
            </a>
            <a href="https://www.facebook.com/andrelustosa" target="_blank" rel="noopener noreferrer" className="text-slate-600 hover:text-[#A89048] transition-colors">
              <Facebook size={16} />
            </a>
          </div>
        </div>
      </footer>

    </div>
  );
}
