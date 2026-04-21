import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateRoomDto, UpdateRoomDto } from './dto/room.dto';

@Injectable()
export class RoomsService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateRoomDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.prisma.room.create({ data: { ...dto, tenant_id: tenantId } });
  }

  async findAll(tenantId: string, opts: { active?: boolean } = {}) {
    const where: Prisma.RoomWhereInput = { tenant_id: tenantId };
    if (opts.active !== undefined) where.active = opts.active;
    return this.prisma.room.findMany({
      where,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const room = await this.prisma.room.findFirst({ where: { id, tenant_id: tenantId } });
    if (!room) throw new NotFoundException('Sala nao encontrada');
    return room;
  }

  async update(tenantId: string, id: string, dto: UpdateRoomDto) {
    await this.findOne(tenantId, id);
    return this.prisma.room.update({ where: { id }, data: dto });
  }

  async archive(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.room.update({ where: { id }, data: { active: false } });
  }
}
