import { Module, Global, forwardRef } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { TelaAoVivoService } from './tela-ao-vivo.service';
import { InboxesModule } from '../inboxes/inboxes.module';

@Global()
@Module({
  imports: [forwardRef(() => InboxesModule)],
  providers: [ChatGateway, TelaAoVivoService],
  exports: [ChatGateway, TelaAoVivoService],
})
export class GatewayModule {}
