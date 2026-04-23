import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { McpController } from './mcp.controller';
import { McpToolsService } from './mcp-tools.service';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [
    JwtModule.register({ secret: process.env.JWT_SECRET || 'fallback-secret' }),
    LeadsModule,
  ],
  controllers: [McpController],
  providers: [McpToolsService],
})
export class McpModule {}
