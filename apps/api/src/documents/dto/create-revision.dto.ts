import { CreateRevisionInput, revisionNameMaxLength } from '@reviewr/shared';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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

  @IsInt()
  @Min(1)
  public baseRevision: number;
}
