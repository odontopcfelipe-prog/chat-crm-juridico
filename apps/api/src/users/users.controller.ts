import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, Request, ForbiddenException, NotFoundException,
  Res, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ChatGateway } from '../gateway/chat.gateway';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly chatGateway: ChatGateway,
  ) {}

  /** Retorna perfil do usuário autenticado */
  @Get('me')
  getMe(@Request() req: any) {
    return this.usersService.findById(req.user.id, req.user?.tenant_id);
  }

  /**
   * Upload de foto de perfil — somente ADMIN.
   * PATCH /users/:id/avatar  (multipart/form-data, campo "file")
   */
  @Post(':id/avatar')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadAvatar(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Request() req: any,
  ) {
    if (!file) throw new ForbiddenException('Nenhum arquivo enviado.');
    return this.usersService.updateAvatar(id, file.buffer, file.mimetype, req.user?.tenant_id);
  }

  /**
   * Remove a foto de perfil — somente ADMIN.
   */
  @Delete(':id/avatar')
  @Roles('ADMIN')
  async removeAvatar(@Param('id') id: string, @Request() req: any) {
    await this.usersService.removeAvatar(id, req.user?.tenant_id);
    return { ok: true };
  }

  /**
   * Serve a foto de perfil — qualquer usuário autenticado.
   * GET /users/:id/avatar
   */
  @Get(':id/avatar')
  async getAvatar(@Param('id') id: string, @Res() res: Response) {
    const result = await this.usersService.getAvatarBuffer(id);
    if (!result) throw new NotFoundException('Foto de perfil não encontrada.');
    res.set('Content-Type', result.mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(result.buffer);
  }

  /** Retorna lista de usuários online (para admin ver quem está no sistema) */
  @Get('online')
  @Roles('ADMIN')
  getOnlineUsers() {
    return { onlineUserIds: this.chatGateway.getOnlineUserIds() };
  }

  @Get('agents')
  findAgents(@Request() req: any) {
    return this.usersService.findAgents(req.user?.tenant_id);
  }

  @Get('lawyers')
  findLawyers(@Request() req: any) {
    return this.usersService.findLawyers(req.user?.tenant_id);
  }

  @Get()
  @Roles('ADMIN')
  findAll(@Request() req: any) {
    return this.usersService.findAll(req.user?.tenant_id);
  }

  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    // Permite ADMIN ou o próprio usuário ver seu perfil
    if (!req.user.roles?.includes('ADMIN') && req.user.id !== id) {
      throw new ForbiddenException('Sem permissão');
    }
    return this.usersService.findById(id, req.user?.tenant_id);
  }

  @Post()
  @Roles('ADMIN')
  create(
    @Request() req: any,
    @Body() data: {
      name: string;
      email: string;
      password: string;
      role?: string;
      roles?: string[];
      phone?: string;
      inboxIds?: string[];
      specialties?: string[];
      cro_number?: string;
      cro_uf?: string;
    },
  ) {
    return this.usersService.create({ ...data, tenant_id: req.user.tenant_id });
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Request() req: any, @Param('id') id: string, @Body() data: { name?: string; email?: string; role?: string; roles?: string[]; password?: string; inboxIds?: string[]; specialties?: string[]; phone?: string; cro_number?: string; cro_uf?: string }) {
    return this.usersService.update(id, data, req.user?.tenant_id);
  }

  @Get(':id/interns')
  findInterns(@Param('id') id: string) {
    return this.usersService.findInterns(id);
  }

  @Patch(':id/supervisors')
  @Roles('ADMIN')
  linkSupervisors(@Param('id') id: string, @Body() data: { lawyerIds: string[] }) {
    return this.usersService.linkSupervisors(id, data.lawyerIds);
  }

  /** Resumo do que o usuário possui (para modal de transferência antes de excluir) */
  @Get(':id/transfer-summary')
  @Roles('ADMIN')
  transferSummary(@Param('id') id: string, @Request() req: any) {
    return this.usersService.getTransferSummary(id, req.user?.tenant_id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Request() req: any, @Param('id') id: string, @Body() body?: { transferToId?: string }) {
    if (req.user.id === id) {
      throw new ForbiddenException('Você não pode remover a si mesmo');
    }
    return this.usersService.remove(id, req.user?.tenant_id, body?.transferToId);
  }
}
