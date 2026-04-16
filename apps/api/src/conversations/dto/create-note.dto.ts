import { IsString, MinLength, MaxLength } from 'class-validator';

export class CreateNoteDto {
  @IsString()
  @MinLength(1, { message: 'Texto da nota não pode ser vazio' })
  @MaxLength(5000, { message: 'Texto excede o limite de 5000 caracteres' })
  text: string;
}
