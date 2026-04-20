import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { FileStorageService } from '../media/filesystem.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, FileStorageService],
  exports: [UsersService],
})
export class UsersModule {}
