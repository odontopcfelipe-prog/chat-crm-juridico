import { ArrayMaxSize, IsArray, IsInt, IsObject, Max, Min } from 'class-validator';

/**
 * Passos CAD — o que a tela manda para a IA desenhar o dente: só o número do dente e medidas.
 * Nenhum escaneamento, imagem ou dado do caso. O serviço ainda filtra cada campo antes de enviar.
 */
export class PedidoDesenhoDto {
  @IsInt()
  @Min(11)
  @Max(48)
  fdi!: number;

  @IsObject()
  medidas!: Record<string, unknown>;

  @IsArray()
  @ArrayMaxSize(11)
  mapaAntagonista!: unknown[];

  @IsArray()
  @ArrayMaxSize(11)
  mapaPreparo!: unknown[];

  @IsObject()
  planoInicial!: Record<string, unknown>;
}
