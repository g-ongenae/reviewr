import { UpdateDocumentInput } from '@reviewr/shared';
import { IsInt, Min } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto.js';

/**
 * Body of `PUT /documents/:id`.
 */
export class UpdateDocumentDto extends CreateDocumentDto implements UpdateDocumentInput {
  /** 0 for a document without a revision yet: an installed build sends the `revision` it was given. */
  @IsInt()
  @Min(0)
  public baseRevision: number;
}
