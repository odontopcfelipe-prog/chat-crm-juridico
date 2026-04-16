import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { SectorsService } from './sectors.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseGuards(JwtAuthGuard)
@Controller('sectors')
export class SectorsController {
  constructor(private svc: SectorsService) {}

  @Get()
  findAll() {
    return this.svc.findAll();
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() body: { name: string; autoRoute?: boolean }) {
    return this.svc.create(body.name, body.autoRoute);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() body: { name: string; autoRoute?: boolean }) {
    return this.svc.update(id, body.name, body.autoRoute);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/users')
  @Roles('ADMIN')
  addUser(@Param('id') id: string, @Body('userId') userId: string) {
    return this.svc.addUser(id, userId);
  }

  @Delete(':id/users/:userId')
  @Roles('ADMIN')
  removeUser(@Param('id') id: string, @Param('userId') uid: string) {
    return this.svc.removeUser(id, uid);
  }
}
