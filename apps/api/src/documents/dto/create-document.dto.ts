import { contentMaxLength, CreateDocumentInput, titleMaxLength } from '@reviewr/shared';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Title and content of `POST /documents`, also extended by the body of `PUT /documents/:id`.
 */
export class CreateDocumentDto implements CreateDocumentInput {
  /**
   * Null when the document is untitled: the title is absent, null, empty or blank. Older apps send
   * `''` for an untitled document, so a blank title is stored as NULL rather than rejected.
   */
  /* eslint-disable no-null/no-null -- the title column is nullable: NULL means untitled */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' && value.trim().length === 0 ? null : value))
  @IsOptional()
  @IsString()
  @MaxLength(titleMaxLength)
  public title: string | null = null;
  /* eslint-enable no-null/no-null */

  @IsString()
  @MaxLength(contentMaxLength)
  public content: string;
}
