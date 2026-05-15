import { Controller, Get, Query, Request, BadRequestException } from '@nestjs/common';
import { InfluencerMessagesService } from './influencer-messages.service';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('influencers/messages')
export class InfluencerMessagesController {
  constructor(private service: InfluencerMessagesService) {}

  @Get()
  @Roles('ADMIN')
  list(
    @Request() req: any,
    @Query('scheduleId') scheduleId?: string,
    @Query('influencerId') influencerId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.list(tenantId, {
      scheduleId,
      influencerId,
      status,
      page: page ? Number(page) : 1,
    });
  }
}
