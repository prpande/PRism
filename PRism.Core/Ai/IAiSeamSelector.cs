namespace PRism.Core.Ai;

public interface IAiSeamSelector
{
    T Resolve<T>() where T : class;
}
