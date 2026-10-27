import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { LabWaitlistService } from './lab-waitlist.service';

/**
 * Quem está enviando, para o limite por minuto. Atrás do Cloudflare Tunnel o req.ip
 * é o do proxy (igual para todo mundo); o cf-connecting-ip o Cloudflare preenche
 * com o IP de verdade e sobrescreve o que vier do cliente.
 */
export function quemEnvia(req: Record<string, any>): string {
  const cf = req?.headers?.['cf-connecting-ip'];
  return typeof cf === 'string' && cf ? cf : String(req?.ip ?? '');
}

export class InscricaoLaboratorioDto {
  @IsString({ message: 'Informe o nome do laboratório' })
  @MaxLength(120)
  lab_name: string;

  @IsString({ message: 'Informe o seu nome' })
  @MaxLength(120)
  contact_name: string;

  @IsString({ message: 'Informe um WhatsApp com DDD' })
  @MaxLength(40)
  phone: string;

  @IsOptional()
  @IsEmail({}, { message: 'E-mail inválido' })
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

/**
 * Lista de espera do caminho "Laboratório de prótese" no /cadastrar (público) e a
 * leitura dela pelo dono da plataforma (SUPER_ADMIN).
 */
@Controller('lab-waitlist')
export class LabWaitlistController {
  constructor(private readonly service: LabWaitlistService) {}

  @Throttle({ default: { ttl: 60000, limit: 5, getTracker: quemEnvia } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post()
  inscrever(@Body() body: InscricaoLaboratorioDto) {
    return this.service.inscrever(body);
  }

  @SuperAdmin()
  @Get()
  listar() {
    return this.service.listar();
  }

  @SuperAdmin()
  @Delete(':id')
  remover(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.remover(id);
  }
}
