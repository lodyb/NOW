import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { MediaTag } from './MediaTag';

@Entity('tags')
export class Tag {
  @PrimaryGeneratedColumn()
  id: number = 0;

  @Column({ unique: true })
  name: string = '';

  @OneToMany(() => MediaTag, (mediaTag) => mediaTag.tag)
  mediaTags!: MediaTag[]; // Using ! instead of = []
}