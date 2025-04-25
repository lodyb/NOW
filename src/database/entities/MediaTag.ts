import { Entity, PrimaryColumn, ManyToOne } from 'typeorm';
import { Media } from './Media';
import { Tag } from './Tag';

@Entity('media_tags')
export class MediaTag {
  @PrimaryColumn()
  mediaId!: number;

  @PrimaryColumn()
  tagId!: number;

  @ManyToOne(() => Media, (media) => media.mediaTags, { onDelete: 'CASCADE' })
  media!: Media;

  @ManyToOne(() => Tag, (tag) => tag.mediaTags, { onDelete: 'CASCADE' })
  tag!: Tag;
}