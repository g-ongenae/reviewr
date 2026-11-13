import { NameRevisionInput, revisionNameMaxLength } from '@reviewr/shared';
import { Transform } from 'class-transformer';
import { IsDefined, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Body of `PATCH /documents/:id/revisions/:revision`.
 */
export class NameRevisionDto implements NameRevisionInput {
  /** Version label, trimmed. Null, empty or blank removes it. The key is required. */
  /* eslint-disable no-null/no-null -- the name column is nullable: NULL means unnamed */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed: string = value.trim();

    return trimmed.length === 0 ? null : trimmed;
  })
  @ValidateIf((dto: NameRevisionDto) => dto.name !== null)
  @IsDefined()
  @IsString()
  @MaxLength(revisionNameMaxLength)
  public name: string | null;
  /* eslint-enable no-null/no-null */
}
