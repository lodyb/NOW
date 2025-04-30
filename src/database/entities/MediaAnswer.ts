import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Media } from './Media';

@Entity('media_answers')
export class MediaAnswer {
  @PrimaryGeneratedColumn()
  id: number = 0;

  @ManyToOne(() => Media, (media) => media.answers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'media_id' })
  media!: Media; // Using ! instead of = new Media()

  @Column()
  answer: string = '';

  @Column({ default: false })
  isPrimary: boolean = false;
}