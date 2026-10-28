import { UpdateDocumentInput } from '@reviewr/shared';
import { IsInt, Min } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto.js';

/**
 * Body of `PUT /documents/:id`.
 */
export class UpdateDocumentDto extends CreateDocumentDto implements UpdateDocumentInput {
  @IsInt()
  @Min(1)
  public baseRevision: number;
}
