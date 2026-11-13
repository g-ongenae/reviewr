import { RenameDocumentInput, titleMaxLength } from '@reviewr/shared';
import { Transform } from 'class-transformer';
import { IsDefined, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Body of `PATCH /documents/:id`.
 */
export class RenameDocumentDto implements RenameDocumentInput {
  /**
   * New title, kept as typed like on `POST /documents`. Null, empty or blank removes the title. The key is
   * required: a body without it is a 400, never a silent "untitled".
   */
  /* eslint-disable no-null/no-null -- the title column is nullable: NULL means untitled */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' && value.trim().length === 0 ? null : value))
  @ValidateIf((dto: RenameDocumentDto) => dto.title !== null)
  @IsDefined()
  @IsString()
  @MaxLength(titleMaxLength)
  public title: string | null;
  /* eslint-enable no-null/no-null */
}
