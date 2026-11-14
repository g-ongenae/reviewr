import { CreateDraftDocumentInput } from '@reviewr/shared';
import { Equals, IsOptional, IsUUID } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto.js';

/**
 * Body of `POST /documents`. `id` and `draftOnly` are optional, since the builds already installed send neither;
 * they live here rather than in `CreateDocumentDto`, so that `PUT /documents/:id` keeps refusing them.
 */
export class CreateDocumentBodyDto extends CreateDocumentDto implements Partial<CreateDraftDocumentInput> {
  /** Client-generated document id: makes the creation safe to send again (see `CreateDraftDocumentInput`). */
  @IsOptional()
  @IsUUID('all')
  public id?: string;

  /** Create no revision, only a draft holding `content`. Only `true` is accepted: omit it to create a revision. */
  @IsOptional()
  @Equals(true)
  public draftOnly?: true;
}
