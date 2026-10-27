import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { LabWaitlistService } from './lab-waitlist.service';

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

  @Throttle({ default: { ttl: 60000, limit: 5 } })
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
}
