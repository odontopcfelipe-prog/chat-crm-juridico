import { IsString, IsIn } from 'class-validator';

export class SendPresenceDto {
  @IsString()
  @IsIn(['composing', 'recording', 'paused'])
  presence: 'composing' | 'recording' | 'paused';
}
