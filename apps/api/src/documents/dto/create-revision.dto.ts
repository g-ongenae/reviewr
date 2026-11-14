import { CreateRevisionInput, revisionNameMaxLength } from '@reviewr/shared';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

/**
 * Body of `POST /documents/:id/revisions`.
 */
export class CreateRevisionDto implements CreateRevisionInput {
  /** Version label, trimmed. Null when the version is unnamed: the name is absent, null, empty or blank. */
  /* eslint-disable no-null/no-null -- the name column is nullable: NULL means unnamed */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed: string = value.trim();

    return trimmed.length === 0 ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  @MaxLength(revisionNameMaxLength)
  public name: string | null = null;
  /* eslint-enable no-null/no-null */

  @IsInt()
  @Min(1)
  public draftVersion: number;

  /** Null or 0 for a document without a revision yet. Required: a body without it is a 400. */
  // eslint-disable-next-line no-null/no-null -- null is the draft's base when there is no revision yet
  @ValidateIf((dto: CreateRevisionDto) => dto.baseRevision !== null)
  @IsInt()
  @Min(0)
  public baseRevision: number | null;
}
