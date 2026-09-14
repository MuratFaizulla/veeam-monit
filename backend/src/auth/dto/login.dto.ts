import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: 'username is required' })
  @MaxLength(256)
  username: string;

  @IsString()
  @IsNotEmpty({ message: 'password is required' })
  @MaxLength(256)
  password: string;
}
