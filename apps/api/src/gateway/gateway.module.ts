import { Module, Global, forwardRef } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { InboxesModule } from '../inboxes/inboxes.module';

@Global()
@Module({
  imports: [forwardRef(() => InboxesModule)],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class GatewayModule {}
