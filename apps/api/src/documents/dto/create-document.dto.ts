import { contentMaxLength, CreateDocumentInput, titleMaxLength } from '@reviewr/shared';
import { IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /documents`.
 */
export class CreateDocumentDto implements CreateDocumentInput {
  @IsString()
  @MaxLength(titleMaxLength)
  public title: string;

  @IsString()
  @MaxLength(contentMaxLength)
  public content: string;
}
