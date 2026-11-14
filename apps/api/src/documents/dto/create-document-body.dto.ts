import { CreateDraftDocumentInput } from '@reviewr/shared';
import { Equals, IsUUID, ValidateIf } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto.js';

/**
 * Body of `POST /documents`. `id` and `draftOnly` are optional, since the builds already installed send neither;
 * they live here rather than in `CreateDocumentDto`, so that `PUT /documents/:id` keeps refusing them.
 *
 * Optional means absent: an explicit `null` is refused like any other wrong value (`@IsOptional()` would let
 * it through, and a null id would reach the database).
 */
export class CreateDocumentBodyDto extends CreateDocumentDto implements Partial<CreateDraftDocumentInput> {
  /** Client-generated document id: makes the creation safe to send again (see `CreateDraftDocumentInput`). */
  @ValidateIf((_: CreateDocumentBodyDto, value: unknown) => value !== undefined)
  @IsUUID('all')
  public id?: string;

  /** Create no revision, only a draft holding `content`. Only `true` is accepted: omit it to create a revision. */
  @ValidateIf((_: CreateDocumentBodyDto, value: unknown) => value !== undefined)
  @Equals(true)
  public draftOnly?: true;
}
