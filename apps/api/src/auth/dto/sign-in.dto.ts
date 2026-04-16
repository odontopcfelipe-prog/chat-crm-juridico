import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignInDto {
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @IsString({ message: 'Senha é obrigatória' })
  @MinLength(4, { message: 'Senha deve ter no mínimo 4 caracteres' })
  password: string;
}
