import { IsString, MaxLength } from 'class-validator';

export class ReactMessageDto {
  @IsString()
  @MaxLength(10)
  emoji: string;
}
